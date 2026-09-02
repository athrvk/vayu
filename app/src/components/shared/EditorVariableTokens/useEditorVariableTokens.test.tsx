/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one editor does with the tokens in its text: paints them, opens one on
 * ⌘-click, and binds the chord that opens the one under the caret.
 *
 * Driven against a Monaco stub rather than a real editor - the API surface used
 * here is six methods, and jsdom has no layout for the real one to measure. The
 * three "does nothing" cases are the load-bearing ones: a response viewer, a
 * script editor and an editor with no provider above it must come out of this
 * hook exactly as they went in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "@/lib/monaco-api";
import type { ResolvedVariable } from "@/types";
import { classifyVariableToken } from "@/lib/variable-token-kind";
import { isVariableTokenModel } from "@/lib/variable-token-models";
import { EditorVariableTokensContext, type EditorVariableTokensValue } from "./context";
import { useEditorVariableTokens } from "./useEditorVariableTokens";

const variables: Record<string, ResolvedVariable> = {};

const openTokenEditor = vi.fn();

const contextValue: EditorVariableTokensValue = {
	classify: (name) => classifyVariableToken(name, { variables }),
	getVariableOrigins: () => [],
	openTokenEditor,
};

/** Monaco's key constants, as `chordKeybinding` reads them. */
const monacoStub = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, KeyA: 31, Digit1: 22 },
} as unknown as MonacoApi;

function stubEditor(lines: string[]) {
	const decorations = { set: vi.fn(), clear: vi.fn() };
	// One object for the editor's life, as Monaco's own model is - the token
	// layer marks it by identity so the language-wide hover can tell a painted
	// model from a response body's.
	const model = {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
	};
	const handlers: {
		mouse?: (e: Monaco.editor.IEditorMouseEvent) => void;
		commands: Array<{ binding: number; run: () => void }>;
	} = { commands: [] };
	let position = { lineNumber: 1, column: 1 };

	const editor = {
		createDecorationsCollection: () => decorations,
		getModel: () => model,
		getPosition: () => position,
		getDomNode: () => ({ getBoundingClientRect: () => ({ left: 10, top: 20 }) }),
		getScrolledVisiblePosition: (p: { column: number }) => ({
			left: p.column * 8,
			top: 4,
			height: 18,
		}),
		onDidChangeModelContent: () => ({ dispose: () => {} }),
		onDidChangeModel: () => ({ dispose: () => {} }),
		onMouseDown: (cb: (e: Monaco.editor.IEditorMouseEvent) => void) => {
			handlers.mouse = cb;
			return { dispose: () => {} };
		},
		addCommand: (binding: number, run: () => void) => {
			handlers.commands.push({ binding, run });
			return null;
		},
		focus: vi.fn(),
	};

	return {
		editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
		model: model as unknown as Monaco.editor.ITextModel,
		decorations,
		handlers,
		moveCaretTo: (column: number, lineNumber = 1) => {
			position = { lineNumber, column };
		},
	};
}

function mount(
	stub: ReturnType<typeof stubEditor>,
	options: { language?: string; readOnly?: boolean; withProvider?: boolean } = {}
) {
	const { language = "json", readOnly = false, withProvider = true } = options;
	const rendered = renderHook(() => useEditorVariableTokens({ language, readOnly }), {
		wrapper: ({ children }) =>
			withProvider ? (
				<EditorVariableTokensContext.Provider value={contextValue}>
					{children}
				</EditorVariableTokensContext.Provider>
			) : (
				<>{children}</>
			),
	});
	// What `CodeEditor` does from `onMount`.
	act(() => rendered.result.current(stub.editor, monacoStub));
	return rendered;
}

/** A ⌘-click landing on `column` of the first line. */
function metaClickAt(stub: ReturnType<typeof stubEditor>, column: number) {
	const preventDefault = vi.fn();
	stub.handlers.mouse?.({
		event: { metaKey: true, ctrlKey: false, preventDefault },
		target: { position: { lineNumber: 1, column } },
	} as unknown as Monaco.editor.IEditorMouseEvent);
	return preventDefault;
}

beforeEach(() => {
	openTokenEditor.mockClear();
	for (const key of Object.keys(variables)) delete variables[key];
});

describe("useEditorVariableTokens", () => {
	it("paints every token with the class its state earns", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}/{{missing}}"]);
		mount(stub);

		expect(stub.decorations.set).toHaveBeenCalledTimes(1);
		const painted = stub.decorations.set.mock.calls[0][0] as Array<{
			range: { startColumn: number };
			options: { inlineClassName: string };
		}>;
		expect(painted.map((d) => d.options.inlineClassName)).toEqual([
			"vayu-variable-token-resolved",
			"vayu-variable-token-undefined",
		]);
		expect(painted[0].range.startColumn).toBe(5);
	});

	it("leaves a read-only editor alone - a response body's `{{x}}` is data", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub, { readOnly: true });
		// Mutation check: drop `!readOnly` from `enabled` and this fails.
		expect(stub.decorations.set).not.toHaveBeenCalled();
		expect(stub.handlers.commands).toHaveLength(0);
	});

	it("marks its model, so the language-wide hover may answer for it", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub);
		expect(isVariableTokenModel(stub.model)).toBe(true);
	});

	it("never marks a read-only model - the hover has to leave a response body alone", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub, { readOnly: true });
		// Mutation check: mark at install rather than in `paint`, or drop the
		// `readOnly` gate, and the response viewer starts answering hovers.
		expect(isVariableTokenModel(stub.model)).toBe(false);
	});

	it("stops marking it once the editor is gone", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		const rendered = mount(stub);
		rendered.unmount();
		expect(isVariableTokenModel(stub.model)).toBe(false);
	});

	it("leaves a script editor alone - the engine never interpolates script source", () => {
		const stub = stubEditor(["pm.test('{{baseUrl}}')"]);
		mount(stub, { language: "javascript" });
		expect(stub.decorations.set).not.toHaveBeenCalled();
	});

	it("does nothing with no provider above it", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub, { withProvider: false });
		expect(stub.decorations.set).not.toHaveBeenCalled();
		expect(stub.handlers.commands).toHaveLength(0);
	});

	it("opens the token under a ⌘-click, over the token's own rectangle", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		const preventDefault = metaClickAt(stub, 8);
		expect(preventDefault).toHaveBeenCalled();
		expect(openTokenEditor).toHaveBeenCalledTimes(1);
		const request = openTokenEditor.mock.calls[0][0];
		expect(request.name).toBe("baseUrl");
		// The editor's box plus the visible position of the token's first column.
		expect(request.rect).toMatchObject({ left: 10 + 5 * 8, top: 24, height: 18 });
	});

	it("keeps a plain click for placing the caret", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);
		stub.handlers.mouse?.({
			event: { metaKey: false, ctrlKey: false, preventDefault: vi.fn() },
			target: { position: { lineNumber: 1, column: 8 } },
		} as unknown as Monaco.editor.IEditorMouseEvent);
		expect(openTokenEditor).not.toHaveBeenCalled();
	});

	it("opens nothing for a run-time token, which has no stored variable", () => {
		const stub = stubEditor(["{{$guid}}"]);
		mount(stub);
		metaClickAt(stub, 4);
		expect(openTokenEditor).not.toHaveBeenCalled();
	});

	it("binds the edit chord, and it reads the caret's own token", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}} {{other}}"]);
		mount(stub);

		expect(stub.handlers.commands).toHaveLength(1);
		// ⇧⌘D - CtrlCmd | Shift | KeyD, as `chordKeybinding` composes it.
		expect(stub.handlers.commands[0].binding).toBe(2048 | 1024 | (31 + 3));

		stub.moveCaretTo(8);
		stub.handlers.commands[0].run();
		expect(openTokenEditor).toHaveBeenCalledTimes(1);
		expect(openTokenEditor.mock.calls[0][0].name).toBe("baseUrl");

		// And nothing when the caret is not in a token at all.
		openTokenEditor.mockClear();
		stub.moveCaretTo(2);
		stub.handlers.commands[0].run();
		expect(openTokenEditor).not.toHaveBeenCalled();
	});

	it("hands focus back to the editor when the popover closes", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);
		metaClickAt(stub, 8);
		openTokenEditor.mock.calls[0][0].onClose();
		expect(stub.editor.focus).toHaveBeenCalled();
	});
});
