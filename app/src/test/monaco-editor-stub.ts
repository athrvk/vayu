/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Enough of Monaco for the GraphQL body's editor round trips, shared by the
 * suites that mount it.
 *
 * The model's offsets are computed against whatever the component last
 * *rendered*, not against text the stub was told about - which is the point: a
 * caret or a reveal aimed at the new document is only correct if the component
 * waited for that document to arrive in the model.
 *
 * Shared rather than copied per suite because each suite needs one more method
 * than the last (`revealLineInCenter` arrived with the outline's click-to-scroll)
 * and a copy does not receive the next one.
 */

/** The latest value each mocked editor was rendered with, by language. */
export const editorValues = new Map<string, string>();
/** The caret each mocked editor was last moved to, by language. */
export const editorPositions = new Map<string, { lineNumber: number; column: number }>();
/** Every line each mocked editor was asked to scroll to, by language, in order. */
export const editorReveals = new Map<string, number[]>();
/** How many times each mocked editor was focused, by language. */
export const editorFocuses = new Map<string, number>();
/** The range each mocked editor was last asked to select, by language. */
export const editorSelections = new Map<string, EditorRange>();

export interface EditorRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export function resetEditorStubs() {
	editorValues.clear();
	editorPositions.clear();
	editorReveals.clear();
	editorFocuses.clear();
	editorSelections.clear();
}

export function offsetAt(text: string, position: { lineNumber: number; column: number }): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1;
	return offset + position.column - 1;
}

export function positionAt(text: string, offset: number) {
	const before = text.slice(0, offset).split("\n");
	return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
}

/** The editor instance `onMount` hands the component, for one language. */
export function fakeEditor(language: string) {
	const text = () => editorValues.get(language) ?? "";
	const model = {
		getOffsetAt: (p: { lineNumber: number; column: number }) => offsetAt(text(), p),
		getPositionAt: (o: number) => positionAt(text(), o),
		uri: { toString: () => `inmemory://${language}` },
		// The rest is what `attachVariablesDiagnostics` needs of the pane's
		// model to hang its masked twin off it.
		getValue: text,
		setValue: () => {},
		isDisposed: () => false,
		onDidChangeContent: () => ({ dispose: () => {} }),
		onWillDispose: () => ({ dispose: () => {} }),
	};
	return {
		getModel: () => model,
		getPosition: () => editorPositions.get(language) ?? { lineNumber: 1, column: 1 },
		setPosition: (p: { lineNumber: number; column: number }) =>
			editorPositions.set(language, p),
		setSelection: (range: EditorRange) => editorSelections.set(language, range),
		revealPositionInCenterIfOutsideViewport: () => {},
		revealLineInCenter: (line: number) =>
			editorReveals.set(language, [...(editorReveals.get(language) ?? []), line]),
		focus: () => editorFocuses.set(language, (editorFocuses.get(language) ?? 0) + 1),
	};
}

/**
 * The Monaco surface the variables pane's mount touches: the JSON language
 * defaults `applyVariablesSchema` writes to, and the model registry
 * `attachVariablesDiagnostics` creates its masked twin in. Mounting the editor
 * is what makes both run, so a stub that lacks either fails every case in a
 * suite rather than the one it belongs to.
 */
export function monacoStub() {
	const models = new Map<string, { isDisposed: () => boolean; dispose: () => void }>();
	return {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		json: {
			jsonDefaults: {
				diagnosticsOptions: { schemas: [] as unknown[] },
				setDiagnosticsOptions: () => {},
			},
		},
		editor: {
			createModel: (value: string, _language: string, uri: { toString: () => string }) => {
				let disposed = false;
				let text = value;
				const model = {
					uri,
					getValue: () => text,
					setValue: (next: string) => {
						text = next;
					},
					isDisposed: () => disposed,
					onDidChangeContent: () => ({ dispose: () => {} }),
					onWillDispose: () => ({ dispose: () => {} }),
					dispose: () => {
						disposed = true;
					},
				};
				models.set(uri.toString(), model);
				return model;
			},
			getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
			getModelMarkers: () => [],
			setModelMarkers: () => {},
			onDidChangeMarkers: () => ({ dispose: () => {} }),
		},
	};
}
