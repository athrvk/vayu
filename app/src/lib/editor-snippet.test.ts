/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Inserting a template at the cursor (#1223).
 *
 * Monaco does not run under vitest, so what is checkable here is the contract
 * with it: the snippet reaches the *snippet controller* rather than being
 * spliced in as text - the difference between tab stops and a script containing
 * `${1:200}` - and the editor is focused first, since the click that asked for
 * the insertion landed on a list beside it.
 */

import { describe, it, expect } from "vitest";
import type * as Monaco from "monaco-editor";
import { insertSnippetAtCursor } from "./editor-snippet";

function fakeEditor() {
	const calls: Array<{ order: number; action: string; payload: unknown }> = [];
	let order = 0;
	const editor = {
		focus: () => {
			calls.push({ order: order++, action: "focus", payload: undefined });
		},
		trigger: (_source: string, action: string, payload: unknown) => {
			calls.push({ order: order++, action, payload });
		},
	} as unknown as Monaco.editor.IStandaloneCodeEditor;
	return { editor, calls };
}

describe("insertSnippetAtCursor", () => {
	it("drives Monaco's snippet controller, so placeholders become tab stops", () => {
		const { editor, calls } = fakeEditor();

		expect(insertSnippetAtCursor(editor, 'pm.test("${1:name}", function () {});')).toBe(true);

		const insert = calls.find((c) => c.action === "editor.action.insertSnippet");
		expect(insert, "the snippet controller is the only correct door").toBeTruthy();
		expect(insert?.payload).toEqual({ snippet: 'pm.test("${1:name}", function () {});' });
	});

	it("focuses the editor before inserting", () => {
		const { editor, calls } = fakeEditor();

		insertSnippetAtCursor(editor, "pm.response.json();");

		const focus = calls.find((c) => c.action === "focus");
		const insert = calls.find((c) => c.action === "editor.action.insertSnippet");
		expect(focus!.order).toBeLessThan(insert!.order);
	});

	it("does nothing when no editor has mounted yet", () => {
		expect(insertSnippetAtCursor(null, "pm.response.json();")).toBe(false);
		expect(insertSnippetAtCursor(undefined, "pm.response.json();")).toBe(false);
	});

	it("refuses an empty template rather than trigger an empty edit", () => {
		const { editor, calls } = fakeEditor();

		expect(insertSnippetAtCursor(editor, "")).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
