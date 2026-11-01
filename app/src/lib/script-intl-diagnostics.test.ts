/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The script editor's `Intl` warning (#3129): the scanner against text, and
 * the attach helper against a hand-rolled model, with no Monaco.
 */

import { describe, it, expect, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "./monaco-api";
import {
	attachIntlDiagnostics,
	findIntlReferences,
	INTL_MARKER_OWNER,
	INTL_MESSAGE,
} from "./script-intl-diagnostics";

/** The text each reference covers, so a case reads as the source it scanned. */
function flagged(text: string): string[] {
	return findIntlReferences(text).map(({ start, end }) => text.slice(start, end));
}

describe("findIntlReferences: what is a bare reference", () => {
	it("flags Intl as a value and as the head of a member access", () => {
		expect(flagged("Intl")).toEqual(["Intl"]);
		expect(flagged("const f = Intl;")).toEqual(["Intl"]);
		expect(flagged("typeof Intl")).toEqual(["Intl"]);
		expect(flagged("({ Intl })")).toEqual(["Intl"]);
		expect(flagged("[...Intl.x]")).toEqual(["Intl"]);
		expect(flagged("Intl.NumberFormat")).toEqual(["Intl"]);
	});

	it("marks the Intl token alone in `new Intl.DateTimeFormat(...)`", () => {
		const text = "const s = new Intl.DateTimeFormat('en-US').format(d);";
		const [reference, ...rest] = findIntlReferences(text);

		expect(rest).toEqual([]);
		expect(reference.start).toBe(text.indexOf("Intl"));
		expect(reference.end).toBe(reference.start + "Intl".length);
	});

	it("flags every occurrence, in source order", () => {
		const text = "Intl.a;\nIntl.b;";
		expect(findIntlReferences(text).map((r) => r.start)).toEqual([0, 8]);
	});

	it("flags Intl in a ternary branch that is followed by a colon", () => {
		expect(flagged("a ? Intl : b")).toEqual(["Intl"]);
	});

	it("flags Intl inside a template's ${...} expression, nested braces included", () => {
		expect(flagged("`x ${Intl} y`")).toEqual(["Intl"]);
		expect(flagged("`${ { a: 1 }.a } ${Intl.x} Intl`")).toEqual(["Intl"]);
		expect(flagged("`${`${Intl}`}`")).toEqual(["Intl"]);
	});
});

describe("findIntlReferences: what is not", () => {
	it.each([
		["a property access", "obj.Intl"],
		["a property access across a newline", "obj\n\t.Intl.x"],
		["an optional-chained property", "x?.Intl"],
		["a longer name", "MyIntl + Intl2 + _Intl + $Intl + Intls"],
		["a single-quoted string", "'Intl.x'"],
		["a double-quoted string with an escaped quote", '"a \\" Intl"'],
		["template text", "`new Intl.X ${1} Intl`"],
		["a line comment", "// Intl.x\nvar a;"],
		["a block comment", "/* Intl\n.x */"],
		["a regex literal", "x = /Intl/.test(s)"],
		["a regex literal after return", "return /Intl/g"],
		["a regex literal whose class holds a slash", "x = /[/]Intl/"],
		["a quote inside a regex literal", "x = /'/; // Intl"],
	])("%s", (_label, text) => {
		expect(flagged(text)).toEqual([]);
	});

	it("still finds a reference that follows each of those", () => {
		expect(flagged("x = /Intl/g; Intl.x")).toEqual(["Intl"]);
		expect(flagged("'Intl'; Intl")).toEqual(["Intl"]);
		expect(flagged("`a ${1} b`; Intl")).toEqual(["Intl"]);
		expect(flagged("/* Intl */ Intl")).toEqual(["Intl"]);
		expect(flagged("a / b / Intl")).toEqual(["Intl"]);
		expect(flagged("(a) / Intl")).toEqual(["Intl"]);
	});

	it("does not read a sentence in an unterminated string as code", () => {
		expect(flagged("'Intl\nIntl")).toEqual(["Intl"]);
	});
});

/*
 * The edges the issue left to the implementation. The name is the user's own,
 * so none of these is the engine-absent global the warning is about:
 *  - an object-literal key is a property name, not a reference;
 *  - a script that declares `Intl` owns the name everywhere in it (no scope
 *    analysis: a declaration in one function silences the whole script).
 * A parameter or destructured binding is not recognised as a declaration.
 */
describe("findIntlReferences: the user's own Intl", () => {
	it("does not flag an object-literal key", () => {
		expect(flagged("({ Intl: 1 })")).toEqual([]);
		expect(flagged("({ a: 1,\n Intl : 2 })")).toEqual([]);
	});

	it("flags the key's neighbours, which are still references", () => {
		expect(flagged("({ Intl: Intl })")).toEqual(["Intl"]);
	});

	it.each(["const", "let", "var", "function", "class"])(
		"leaves a script that declares it with %s alone",
		(keyword) => {
			expect(flagged(`${keyword} Intl = {}; Intl.x; new Intl.y()`)).toEqual([]);
		}
	);

	it("flags a parameter, which it does not recognise as a declaration", () => {
		expect(flagged("function f(Intl) { return Intl; }")).toEqual(["Intl", "Intl"]);
	});
});

interface FakeModel {
	text: string;
	disposed: boolean;
	contentListeners: Set<() => void>;
	getValue: () => string;
	getPositionAt: (offset: number) => { lineNumber: number; column: number };
	isDisposed: () => boolean;
	onDidChangeContent: (listener: () => void) => Monaco.IDisposable;
}

function fakeModel(text: string): FakeModel {
	const model: FakeModel = {
		text,
		disposed: false,
		contentListeners: new Set(),
		getValue: () => model.text,
		getPositionAt: (offset) => {
			const before = model.text.slice(0, offset).split("\n");
			return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
		},
		isDisposed: () => model.disposed,
		onDidChangeContent: (listener) => {
			model.contentListeners.add(listener);
			return { dispose: () => model.contentListeners.delete(listener) };
		},
	};
	return model;
}

function edit(model: FakeModel, text: string) {
	model.text = text;
	for (const listener of [...model.contentListeners]) listener();
}

function setup(initial: FakeModel | null) {
	let current = initial;
	const modelListeners = new Set<() => void>();
	const disposeListeners = new Set<() => void>();
	const setModelMarkers = vi.fn();
	const monaco = {
		MarkerSeverity: { Warning: 4 },
		editor: { setModelMarkers },
	} as unknown as MonacoApi;
	const editor = {
		getModel: () => current,
		onDidChangeModel: (listener: () => void) => {
			modelListeners.add(listener);
			return { dispose: () => modelListeners.delete(listener) };
		},
		onDidDispose: (listener: () => void) => {
			disposeListeners.add(listener);
			return { dispose: () => disposeListeners.delete(listener) };
		},
	} as unknown as Monaco.editor.IStandaloneCodeEditor;
	const handle = attachIntlDiagnostics(monaco, editor);
	return {
		handle,
		setModelMarkers,
		swapModel: (next: FakeModel | null) => {
			current = next;
			for (const listener of [...modelListeners]) listener();
		},
		disposeEditor: () => {
			for (const listener of [...disposeListeners]) listener();
		},
	};
}

describe("attachIntlDiagnostics", () => {
	it("writes a warning on the Intl token under its own owner", () => {
		const model = fakeModel("var d = 1;\nnew Intl.DateTimeFormat('en-US');");
		const { setModelMarkers } = setup(model);

		expect(INTL_MARKER_OWNER).not.toBe("javascript");
		expect(setModelMarkers).toHaveBeenCalledTimes(1);
		expect(setModelMarkers).toHaveBeenCalledWith(model, INTL_MARKER_OWNER, [
			{
				severity: 4,
				message: INTL_MESSAGE,
				startLineNumber: 2,
				startColumn: 5,
				endLineNumber: 2,
				endColumn: 9,
			},
		]);
	});

	it("says what to do instead, in the words the issue settled on", () => {
		expect(INTL_MESSAGE).toBe(
			"No `Intl` in Vayu scripts - use `require('moment')` for dates, or format by hand; `toLocale*` methods ignore their options here."
		);
	});

	it("writes nothing for a script without Intl", () => {
		const { setModelMarkers } = setup(fakeModel("pm.test('x', () => {});"));

		expect(setModelMarkers).not.toHaveBeenCalled();
	});

	it("follows an edit: adds, moves and removes the warning", () => {
		const model = fakeModel("1;");
		const { setModelMarkers } = setup(model);

		edit(model, "Intl.x");
		expect(setModelMarkers).toHaveBeenLastCalledWith(model, INTL_MARKER_OWNER, [
			expect.objectContaining({ startLineNumber: 1, startColumn: 1, endColumn: 5 }),
		]);

		edit(model, "\nIntl.x");
		expect(setModelMarkers).toHaveBeenLastCalledWith(model, INTL_MARKER_OWNER, [
			expect.objectContaining({ startLineNumber: 2, startColumn: 1, endColumn: 5 }),
		]);

		edit(model, "moment.x");
		expect(setModelMarkers).toHaveBeenLastCalledWith(model, INTL_MARKER_OWNER, []);
		expect(setModelMarkers).toHaveBeenCalledTimes(3);
	});

	it("does not write when an edit leaves the warnings where they were", () => {
		const model = fakeModel("Intl.x");
		const { setModelMarkers } = setup(model);
		expect(setModelMarkers).toHaveBeenCalledTimes(1);

		edit(model, "Intl.y");
		edit(model, "Intl.yz");
		expect(setModelMarkers).toHaveBeenCalledTimes(1);
	});

	it("does not write when an edit leaves a clean script clean", () => {
		const model = fakeModel("a;");
		const { setModelMarkers } = setup(model);

		edit(model, "b;");
		expect(setModelMarkers).not.toHaveBeenCalled();
	});

	it("clears the markers and stops listening when disposed", () => {
		const model = fakeModel("Intl.x");
		const { handle, setModelMarkers } = setup(model);

		handle.dispose();
		expect(setModelMarkers).toHaveBeenLastCalledWith(model, INTL_MARKER_OWNER, []);
		expect(model.contentListeners.size).toBe(0);

		const writes = setModelMarkers.mock.calls.length;
		edit(model, "Intl.a Intl.b");
		handle.dispose();
		expect(setModelMarkers).toHaveBeenCalledTimes(writes);
	});

	it("clears the markers when the editor is disposed", () => {
		const model = fakeModel("Intl.x");
		const { disposeEditor, setModelMarkers } = setup(model);

		disposeEditor();

		expect(setModelMarkers).toHaveBeenLastCalledWith(model, INTL_MARKER_OWNER, []);
		expect(model.contentListeners.size).toBe(0);
	});

	it("moves to a new model: clears the old one, marks the new one", () => {
		const first = fakeModel("Intl.x");
		const second = fakeModel("  Intl.y");
		const { swapModel, setModelMarkers } = setup(first);

		swapModel(second);

		expect(setModelMarkers).toHaveBeenCalledWith(first, INTL_MARKER_OWNER, []);
		expect(setModelMarkers).toHaveBeenLastCalledWith(second, INTL_MARKER_OWNER, [
			expect.objectContaining({ startColumn: 3, endColumn: 7 }),
		]);
		expect(first.contentListeners.size).toBe(0);
		expect(second.contentListeners.size).toBe(1);
	});

	it("leaves a model that was disposed under it alone, and survives having none", () => {
		const first = fakeModel("Intl.x");
		const { swapModel, setModelMarkers, handle } = setup(first);
		const writes = setModelMarkers.mock.calls.length;

		first.disposed = true;
		swapModel(null);
		handle.dispose();

		expect(setModelMarkers).toHaveBeenCalledTimes(writes);
	});

	it("starts clean on a model with no Intl after one that had it", () => {
		const first = fakeModel("Intl.x");
		const second = fakeModel("a;");
		const { swapModel, setModelMarkers } = setup(first);

		swapModel(second);

		expect(setModelMarkers).not.toHaveBeenCalledWith(
			second,
			INTL_MARKER_OWNER,
			expect.anything()
		);
	});
});
