/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Inserting a template at the cursor (#1223).
 *
 * **The first version of this suite passed against code that did nothing.** It
 * mocked the editor as a bare object with a `trigger` spy and asserted that
 * `insertSnippetAtCursor` called it with `"editor.action.insertSnippet"` - so it
 * checked the call the app makes, never that Monaco answers it. It does not:
 * that command is VS Code's workbench, and the standalone editor registers the
 * snippet controller as a *contribution* instead. `trigger` ignores an id it
 * cannot resolve, so clicking a snippet silently did nothing while the suite
 * stayed green.
 *
 * The fake below is therefore shaped like the real editor rather than like the
 * call: `trigger` resolves nothing (as Monaco's does for an unknown action) and
 * the only working door is `getContribution("snippetController2").insert`.
 * Mutation check: put the `trigger` spelling back and every case here reddens.
 */

import { describe, it, expect } from "vitest";
import type * as Monaco from "monaco-editor";
import { insertSnippetAtCursor } from "./editor-snippet";

function fakeEditor({ withController = true }: { withController?: boolean } = {}) {
	const events: string[] = [];
	const inserted: string[] = [];

	const controller = {
		getId: () => "snippetController2",
		dispose: () => {},
		insert: (template: string) => {
			events.push("insert");
			inserted.push(template);
		},
	};

	const editor = {
		focus: () => events.push("focus"),
		/*
		 * Monaco resolves the id against the editor's own action map and returns
		 * without complaint when nothing matches - which is the whole reason the
		 * wrong id was invisible. The fake does the same: no throw, no effect.
		 */
		trigger: (_source: string, _handlerId: string, _payload: unknown) => {
			events.push("trigger");
		},
		getContribution: (id: string) =>
			withController && id === "snippetController2" ? controller : null,
	} as unknown as Monaco.editor.IStandaloneCodeEditor;

	return { editor, events, inserted };
}

describe("insertSnippetAtCursor", () => {
	it("hands the template to the editor's snippet controller", () => {
		const { editor, inserted } = fakeEditor();

		expect(insertSnippetAtCursor(editor, 'pm.test("${1:name}", function () {});')).toBe(true);

		// Verbatim: the placeholders are what the controller turns into tab
		// stops, and expanding them here would defeat the whole point.
		expect(inserted).toEqual(['pm.test("${1:name}", function () {});']);
	});

	it("focuses the editor before inserting", () => {
		const { editor, events } = fakeEditor();

		insertSnippetAtCursor(editor, "pm.response.json();");

		expect(events).toEqual(["focus", "insert"]);
	});

	it("reports failure when the editor carries no snippet controller", () => {
		const { editor, events } = fakeEditor({ withController: false });

		// The honest answer for a Monaco build that no longer registers it under
		// this id - which is what a silent `trigger` could never tell us.
		expect(insertSnippetAtCursor(editor, "pm.response.json();")).toBe(false);
		expect(events).toEqual([]);
	});

	it("does nothing when no editor has mounted yet", () => {
		expect(insertSnippetAtCursor(null, "pm.response.json();")).toBe(false);
		expect(insertSnippetAtCursor(undefined, "pm.response.json();")).toBe(false);
	});

	it("refuses an empty template rather than open an empty snippet session", () => {
		const { editor, events } = fakeEditor();

		expect(insertSnippetAtCursor(editor, "")).toBe(false);
		expect(events).toEqual([]);
	});
});
