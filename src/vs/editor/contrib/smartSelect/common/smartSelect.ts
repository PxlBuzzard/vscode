/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import * as arrays from 'vs/base/common/arrays';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { TPromise } from 'vs/base/common/winjs.base';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ICommonCodeEditor, IEditorContribution, IFoundBracket } from 'vs/editor/common/editorCommon';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { editorAction, ServicesAccessor, IActionOptions, EditorAction, commonEditorContribution } from 'vs/editor/common/editorCommonExtensions';
import { TokenSelectionSupport, ILogicalSelectionEntry } from './tokenSelectionSupport';
import { ICursorPositionChangedEvent } from 'vs/editor/common/controller/cursorEvents';

// --- selection state machine

class State {

	public editor: ICommonCodeEditor;
	public next: State;
	public previous: State;
	public selection: Range;

	constructor(editor: ICommonCodeEditor) {
		this.editor = editor;
		this.next = null;
		this.previous = null;
		this.selection = editor.getSelection();
	}
}

// --- shared state between grow and shrink actions
var state: State = null;
var ignoreSelection = false;

// -- action implementation

@commonEditorContribution
class SmartSelectController implements IEditorContribution {

	private static ID = 'editor.contrib.smartSelectController';

	public static get(editor: ICommonCodeEditor): SmartSelectController {
		return editor.getContribution<SmartSelectController>(SmartSelectController.ID);
	}

	private _tokenSelectionSupport: TokenSelectionSupport;

	constructor(
		private editor: ICommonCodeEditor,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		this._tokenSelectionSupport = instantiationService.createInstance(TokenSelectionSupport);
	}

	public dispose(): void {
	}

	public getId(): string {
		return SmartSelectController.ID;
	}

	public run(forward: boolean): TPromise<void> {

		var selection = this.editor.getSelection();
		var model = this.editor.getModel();

		// forget about current state
		if (state) {
			if (state.editor !== this.editor) {
				state = null;
			}
		}

		var promise: TPromise<void> = TPromise.as(null);
		if (!state) {
			promise = this._tokenSelectionSupport.getRangesToPosition(model.uri, selection.getStartPosition()).then((elements: ILogicalSelectionEntry[]) => {

				if (arrays.isFalsyOrEmpty(elements)) {
					return;
				}

				var lastState: State;
				elements.filter((element) => {
					// filter ranges inside the selection
					var selection = this.editor.getSelection();
					var range = new Range(element.range.startLineNumber, element.range.startColumn, element.range.endLineNumber, element.range.endColumn);
					return range.containsPosition(selection.getStartPosition()) && range.containsPosition(selection.getEndPosition());

				}).forEach((element) => {
					// create ranges
					var range = element.range;
					var state = new State(this.editor);
					state.selection = new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
					if (lastState) {
						state.next = lastState;
						lastState.previous = state;
					}
					lastState = state;
				});

				// insert current selection
				var editorState = new State(this.editor);
				editorState.next = lastState;
				if (lastState) {
					lastState.previous = editorState;
				}
				state = editorState;

				// listen to caret move and forget about state
				var unhook = this.editor.onDidChangeCursorPosition((e: ICursorPositionChangedEvent) => {
					if (ignoreSelection) {
						return;
					}
					state = null;
					unhook.dispose();
				});
			});
		}

		return promise.then(() => {

			if (!state) {
				return;
			}

			state = forward ? state.next : state.previous;
			if (!state) {
				return;
			}

			ignoreSelection = true;
			try {
				this.editor.setSelection(state.selection);
			} finally {
				ignoreSelection = false;
			}

			return;
		});
	}
}

@commonEditorContribution
class ExpandBracketController implements IEditorContribution {
	private static ID = 'editor.contrib.expandBracketController';

	public static get(editor: ICommonCodeEditor): ExpandBracketController {
		return editor.getContribution<ExpandBracketController>(ExpandBracketController.ID);
	}

	private _tokenSelectionSupport: TokenSelectionSupport;

	constructor(
		private editor: ICommonCodeEditor,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		this._tokenSelectionSupport = instantiationService.createInstance(TokenSelectionSupport);
	}

	public dispose(): void {
	}

	public getId(): string {
		return ExpandBracketController.ID;
	}

	public run(): TPromise<void> {
		let promise: TPromise<void> = TPromise.as(null);
		let newSelections: Selection[];
		const model = this.editor.getModel();
		if (model) {
			newSelections = this.editor.getSelections().map(selection => {
				const originalStartPosition = selection.getStartPosition();
				const originalEndPosition = selection.getEndPosition();

				// check for a direct neighbor bracket to the current selection
				let prevBracket = model.findPrevBracket(originalStartPosition);
				if (prevBracket && prevBracket.range.getEndPosition().equals(originalStartPosition)) {
					const matchPrevBracket = model.matchBracket(prevBracket.range.getStartPosition());
					if (matchPrevBracket && prevBracket.isOpen) {
						return new Selection(
							matchPrevBracket[0].startLineNumber,
							matchPrevBracket[0].startColumn,
							matchPrevBracket[1].endLineNumber,
							matchPrevBracket[1].endColumn);
					} else if (matchPrevBracket && !prevBracket.isOpen) {
						return new Selection(
							matchPrevBracket[0].endLineNumber,
							matchPrevBracket[0].endColumn,
							matchPrevBracket[1].startLineNumber,
							matchPrevBracket[1].startColumn);
					}
				}

				// check if the selection is directly inside a set of brackets
				let matchPrev = model.matchBracket(originalStartPosition);
				let matchNext = model.matchBracket(originalEndPosition);
				if (matchPrev && matchNext &&
					matchPrev[0].equalsRange(matchNext[1]) &&
					!matchPrev[0].getStartPosition().equals(originalStartPosition)) {
					return new Selection(
						matchPrev[0].startLineNumber,
						matchPrev[0].startColumn,
						matchPrev[1].endLineNumber,
						matchPrev[1].endColumn);
				}

				// check if the cursor, not selection, is directly outside a set of matchable brackets
				if (originalStartPosition.equals(originalEndPosition) && matchPrev) {
					return new Selection(
						matchPrev[0].startLineNumber,
						matchPrev[0].startColumn,
						matchPrev[1].endLineNumber,
						matchPrev[1].endColumn);
				} else if (originalStartPosition.equals(originalEndPosition) && matchNext) {
					return new Selection(
						matchNext[0].startLineNumber,
						matchNext[0].startColumn,
						matchNext[1].endLineNumber,
						matchNext[1].endColumn);
				}

				// find previous open bracket with no matching bracket from the start of the selection
				let currentPosition = originalStartPosition.clone();
				let setCount = 0;
				do {
					prevBracket = model.findPrevBracket(currentPosition);
					if (prevBracket) {
						currentPosition = prevBracket.range.getStartPosition();
						!prevBracket.isOpen ? setCount++ : setCount--;
					}
				} while (prevBracket && setCount >= 0);

				// find next closed bracket with no matching bracket from the end of the selection
				let nextBracket: IFoundBracket = null;
				currentPosition = originalEndPosition.clone();
				setCount = 0;
				do {
					nextBracket = model.findNextBracket(currentPosition);
					if (nextBracket) {
						currentPosition = nextBracket.range.getEndPosition();
						nextBracket.isOpen ? setCount++ : setCount--;
					}
				} while (nextBracket && setCount >= 0);

				// check validity of previous and next brackets
				if (!prevBracket && !nextBracket) {
					return selection;
				}

				// pick the outermost set of brackets
				matchPrev = prevBracket ? model.matchBracket(prevBracket.range.getStartPosition()) : null;
				matchNext = nextBracket ? model.matchBracket(nextBracket.range.getStartPosition()) : null;
				let bracketsToSelect: [Range, Range] = null;
				if (!matchPrev) {
					bracketsToSelect = matchNext;
				} else if (!matchNext) {
					bracketsToSelect = matchPrev;
				} else if (matchPrev[1].getEndPosition().isBefore(matchNext[0].getEndPosition())) {
					bracketsToSelect = matchNext;
				} else if (!matchPrev[1].getEndPosition().isBefore(matchNext[0].getEndPosition())) {
					bracketsToSelect = matchPrev;
				} else {
					return new Selection(
						matchPrev[0].startLineNumber,
						matchPrev[0].startColumn,
						matchPrev[1].endLineNumber,
						matchPrev[1].endColumn);
				}

				if (bracketsToSelect && bracketsToSelect === matchPrev) {
					return new Selection(
						bracketsToSelect[0].endLineNumber,
						bracketsToSelect[0].endColumn,
						bracketsToSelect[1].startLineNumber,
						bracketsToSelect[1].startColumn);
				} else if (bracketsToSelect && bracketsToSelect === matchNext) {
					return new Selection(
						bracketsToSelect[0].startLineNumber,
						bracketsToSelect[0].startColumn,
						bracketsToSelect[1].endLineNumber,
						bracketsToSelect[1].endColumn);
				}

				return selection;
			});
		}

		// select the brackets
		return promise.then(() => {
			if (!model) {
				return;
			}

			if (newSelections.length > 0) {
				this.editor.setSelections(newSelections);
			}
			return;
		});
	}
}

abstract class AbstractSmartSelect extends EditorAction {

	private _forward: boolean;

	constructor(forward: boolean, opts: IActionOptions) {
		super(opts);
		this._forward = forward;
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): TPromise<void> {
		let controller = SmartSelectController.get(editor);
		if (controller) {
			return controller.run(this._forward);
		}
		return undefined;
	}
}


@editorAction
class GrowSelectionAction extends AbstractSmartSelect {
	constructor() {
		super(true, {
			id: 'editor.action.smartSelect.grow',
			label: nls.localize('smartSelect.grow', "Expand Selection"),
			alias: 'Expand Selection',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.RightArrow,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyMod.Shift | KeyCode.RightArrow }
			}
		});
	}
}

@editorAction
class ShrinkSelectionAction extends AbstractSmartSelect {
	constructor() {
		super(false, {
			id: 'editor.action.smartSelect.shrink',
			label: nls.localize('smartSelect.shrink', "Shrink Selection"),
			alias: 'Shrink Selection',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.LeftArrow,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyMod.Shift | KeyCode.LeftArrow }
			}
		});
	}
}

@editorAction
class SelectBracketAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.expandSelectionToBrackets',
			label: nls.localize('smartSelect.expandSelectionToBrackets', "Expand Selection To Brackets"),
			alias: 'Expand Selection To Brackets',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.US_SLASH
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): TPromise<void> {
		let controller = ExpandBracketController.get(editor);
		if (controller) {
			return controller.run();
		}
		return undefined;
	}
}
