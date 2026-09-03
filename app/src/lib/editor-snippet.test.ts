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
import { insertSnippetAtCursor, snippetLanding } from "./editor-snippet";

interface FakeOptions {
	withController?: boolean;
	/** The document, one string per line. */
	lines?: string[];
	/** Where the caret sits, 1-based as Monaco counts. */
	cursor?: { lineNumber: number; column: number };
	/** A selection, when the author has one. Its end is where a caret would go. */
	selectionEnd?: { lineNumber: number; column: number };
}

function fakeEditor({
	withController = true,
	lines = [""],
	cursor = { lineNumber: 1, column: 1 },
	selectionEnd,
}: FakeOptions = {}) {
	const events: string[] = [];
	const inserted: string[] = [];
	let position = cursor;

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
		getModel: () => ({
			getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
			getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? "").length + 1,
			getLineCount: () => lines.length,
			getValueLength: () => lines.join("\n").length,
		}),
		getPosition: () => position,
		setPosition: (next: { lineNumber: number; column: number }) => {
			events.push("setPosition");
			position = next;
		},
		getSelection: () =>
			selectionEnd
				? { getEndPosition: () => selectionEnd }
				: { getEndPosition: () => cursor },
	} as unknown as Monaco.editor.IStandaloneCodeEditor;

	return { editor, events, inserted, positionNow: () => position };
}

describe("insertSnippetAtCursor", () => {
	it("hands the template to the editor's snippet controller", () => {
		const { editor, inserted } = fakeEditor();

		expect(insertSnippetAtCursor(editor, 'pm.test("${1:name}", function () {});')).toEqual({
			placement: "cursor",
		});

		// Verbatim: the placeholders are what the controller turns into tab
		// stops, and expanding them here would defeat the whole point.
		expect(inserted).toEqual(['pm.test("${1:name}", function () {});']);
	});

	it("focuses the editor before inserting", () => {
		const { editor, events } = fakeEditor();

		insertSnippetAtCursor(editor, "pm.response.json();");

		expect(events.indexOf("focus")).toBeLessThan(events.indexOf("insert"));
	});

	/*
	 * Where it lands. The click is on a list, so it cannot move the caret, and
	 * the caret is wherever the author last left it - including the middle of a
	 * statement, or over a selection. Every template is a whole statement, so
	 * neither case may be taken literally. Both of these were measured against
	 * a real editor before they were written down (see the module comment).
	 */
	describe("where the template lands", () => {
		it("goes to the end of the caret's line, never into it", () => {
			const { editor, inserted, positionNow } = fakeEditor({
				lines: ["const t = Date.now();"],
				cursor: { lineNumber: 1, column: 12 },
			});

			insertSnippetAtCursor(editor, "pm.environment.set();");

			/*
			 * Column 12 is inside `Date.now()`. Inserting there splits the
			 * statement into `const t = D` and `ate.now();` however much
			 * whitespace is wrapped around the template, which is why the column
			 * is discarded rather than padded.
			 */
			expect(positionNow()).toEqual({ lineNumber: 1, column: 22 });
			expect(inserted).toEqual(["\npm.environment.set();"]);
		});

		it("lands on a blank line without pushing it down", () => {
			const { editor, inserted, positionNow } = fakeEditor({
				lines: ["if (ok) {", "\t", "}"],
				cursor: { lineNumber: 2, column: 1 },
			});

			insertSnippetAtCursor(editor, "pm.environment.set();");

			// After the indentation, which is what the author was lining up.
			expect(positionNow()).toEqual({ lineNumber: 2, column: 2 });
			expect(inserted).toEqual(["pm.environment.set();"]);
		});

		it("collapses a selection instead of replacing it", () => {
			const { editor, inserted, positionNow } = fakeEditor({
				lines: ["const keep = 1;", "const alsoKeep = 2;"],
				cursor: { lineNumber: 1, column: 7 },
				selectionEnd: { lineNumber: 1, column: 11 },
			});

			insertSnippetAtCursor(editor, "pm.environment.set();");

			/*
			 * `SnippetSession` builds its edit from the selection, so left alone
			 * this click would have replaced the selected `keep` - measured:
			 * `const pm.environment.set(); = 1;`. The caret goes to the end of
			 * the selection's line, and the line survives intact.
			 */
			expect(positionNow()).toEqual({ lineNumber: 1, column: 16 });
			expect(inserted).toEqual(["\npm.environment.set();"]);
		});

		it("appends to the end when the caret is Monaco's default rather than the author's", () => {
			const { editor, inserted, positionNow } = fakeEditor({
				lines: ["const first = 1;", "const second = 2;"],
				cursor: { lineNumber: 1, column: 1 },
			});

			const result = insertSnippetAtCursor(editor, "pm.environment.set();");

			/*
			 * 1:1 on a script nobody has clicked into is Monaco's default, not a
			 * decision - and the GraphQL explorer answers the same question the
			 * same way, appending a new operation rather than splicing at offset
			 * 0 (`insert-skeleton.ts`).
			 */
			expect(result).toEqual({ placement: "end-of-script" });
			expect(positionNow()).toEqual({ lineNumber: 2, column: 18 });
			expect(inserted).toEqual(["\npm.environment.set();"]);
		});

		it("takes 1:1 literally in an empty script, where it is the only place to be", () => {
			const { editor, inserted } = fakeEditor({
				lines: [""],
				cursor: { lineNumber: 1, column: 1 },
			});

			expect(insertSnippetAtCursor(editor, "pm.environment.set();")).toEqual({
				placement: "cursor",
			});
			expect(inserted).toEqual(["pm.environment.set();"]);
		});

		it("still inserts when the editor can offer no model or position", () => {
			const { editor, inserted } = fakeEditor();
			// A stubbed editor in another suite, or one mid-teardown: the
			// landing rule is a refinement, never a precondition.
			(editor as unknown as { getModel: () => null }).getModel = () => null;

			expect(insertSnippetAtCursor(editor, "pm.response.json();")).toEqual({
				placement: "cursor",
			});
			expect(inserted).toEqual(["pm.response.json();"]);
		});
	});

	it("reports failure when the editor carries no snippet controller", () => {
		const { editor, events } = fakeEditor({ withController: false });

		// The honest answer for a Monaco build that no longer registers it under
		// this id - which is what a silent `trigger` could never tell us.
		expect(insertSnippetAtCursor(editor, "pm.response.json();")).toBeNull();
		expect(events).toEqual([]);
	});

	it("does nothing when no editor has mounted yet", () => {
		expect(insertSnippetAtCursor(null, "pm.response.json();")).toBeNull();
		expect(insertSnippetAtCursor(undefined, "pm.response.json();")).toBeNull();
	});

	it("refuses an empty template rather than open an empty snippet session", () => {
		const { editor, events } = fakeEditor();

		expect(insertSnippetAtCursor(editor, "")).toBeNull();
		expect(events).toEqual([]);
	});
});

/*
 * The rule on its own: one question about the line the caret is on - is there
 * code on it already, or is it the empty line the author left for this.
 */
describe("snippetLanding", () => {
	it.each([
		["", ""],
		["   ", ""],
		["\t\t", ""],
		["const t = 1;", "\n"],
		["\tpm.test();", "\n"],
	])("%o", (line, before) => {
		expect(snippetLanding(line as string)).toEqual({ before });
	});
});
