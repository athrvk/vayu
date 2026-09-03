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
 * What one editor does with the tokens in its text: paints them, shows the one
 * under the pointer, opens one on ⌘-click, and binds the chord that opens the
 * one under the caret.
 *
 * Driven against a Monaco stub rather than a real editor - the API surface used
 * here is six methods, and jsdom has no layout for the real one to measure. The
 * three "does nothing" cases are the load-bearing ones: a response viewer, a
 * script editor and an editor with no provider above it must come out of this
 * hook exactly as they went in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "@/lib/monaco-api";
import type { ResolvedVariable } from "@/types";
import { classifyVariableToken } from "@/lib/variable-token-kind";
import { TIMING } from "@/config/timing";
import { EditorVariableTokensContext, type EditorVariableTokensValue } from "./context";
import { useEditorVariableTokens } from "./useEditorVariableTokens";

const variables: Record<string, ResolvedVariable> = {};

const openTokenEditor = vi.fn();
const setHoveredToken = vi.fn();

const contextValue: EditorVariableTokensValue = {
	classify: (name) => classifyVariableToken(name, { variables }),
	getVariableOrigins: () => [],
	openTokenEditor,
	setHoveredToken,
};

/** Monaco's key constants, as `chordKeybinding` reads them. */
const monacoStub = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
	KeyCode: { Enter: 3, KeyA: 31, Digit1: 22 },
} as unknown as MonacoApi;

function stubEditor(lines: string[]) {
	const decorations = { set: vi.fn(), clear: vi.fn() };
	// One object for the editor's life, as Monaco's own model is. `getLineCount`
	// is a spy because it is the tell of a whole-model scan - see the hover case
	// that asserts a mouse move does not perform one.
	const model = {
		getLineCount: vi.fn(() => lines.length),
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? "",
	};
	const handlers: {
		mouse?: (e: Monaco.editor.IEditorMouseEvent) => void;
		move?: (e: Monaco.editor.IEditorMouseEvent) => void;
		leave?: () => void;
		scroll?: () => void;
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
		onMouseMove: (cb: (e: Monaco.editor.IEditorMouseEvent) => void) => {
			handlers.move = cb;
			return { dispose: () => {} };
		},
		onMouseLeave: (cb: () => void) => {
			handlers.leave = cb;
			return { dispose: () => {} };
		},
		onDidScrollChange: (cb: () => void) => {
			handlers.scroll = cb;
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
		lineCount: model.getLineCount,
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

/** The pointer resting on `column` of the first line, past the hover delay. */
function hoverAt(stub: ReturnType<typeof stubEditor>, column: number | null) {
	act(() => {
		stub.handlers.move?.({
			target: { position: column === null ? null : { lineNumber: 1, column } },
		} as unknown as Monaco.editor.IEditorMouseEvent);
		vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS);
	});
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
	vi.useFakeTimers();
	openTokenEditor.mockClear();
	setHoveredToken.mockClear();
	for (const key of Object.keys(variables)) delete variables[key];
});

afterEach(() => {
	vi.useRealTimers();
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

	it("shows the token the pointer rests on, over the token's own rectangle", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		hoverAt(stub, 8);
		expect(setHoveredToken).toHaveBeenCalledTimes(1);
		expect(setHoveredToken.mock.calls[0][0]).toMatchObject({
			name: "baseUrl",
			rect: { left: 10 + 5 * 8, top: 24, height: 18 },
		});
	});

	it("reads one line per mouse move, not the whole model", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		// The paint at install walks the model; the pointer must not.
		stub.lineCount.mockClear();
		hoverAt(stub, 8);
		expect(setHoveredToken).toHaveBeenCalledTimes(1);
		// Mutation check: scan with `variableTokenRanges` here and this fails -
		// which is a full scan of a body that can be thousands of lines, per
		// character of pointer travel.
		expect(stub.lineCount).not.toHaveBeenCalled();
	});

	it("waits the tooltip delay out, so sweeping across a body opens nothing", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		act(() => {
			stub.handlers.move?.({
				target: { position: { lineNumber: 1, column: 8 } },
			} as unknown as Monaco.editor.IEditorMouseEvent);
			vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS - 1);
		});
		// Mutation check: open on the move itself and this fails.
		expect(setHoveredToken).not.toHaveBeenCalled();
	});

	it("stays open while the pointer moves inside the token it is showing", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		hoverAt(stub, 8);
		hoverAt(stub, 10);
		// One open, and no take-down in between: re-arming the timer per character
		// is a tooltip that never opens while the hand is not perfectly still.
		expect(setHoveredToken.mock.calls).toEqual([
			[expect.objectContaining({ name: "baseUrl" })],
		]);
	});

	it("takes it down off the token, on a scroll, and when the editor goes", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		const rendered = mount(stub);

		hoverAt(stub, 8);
		hoverAt(stub, 2);
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);

		hoverAt(stub, 8);
		act(() => stub.handlers.scroll?.());
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);

		hoverAt(stub, 8);
		act(() => stub.handlers.leave?.());
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);

		hoverAt(stub, 8);
		rendered.unmount();
		// A card left hanging over whatever replaces the editor is the failure
		// this one guards.
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);
	});

	it("never shows one in a read-only editor - a response body's `{{x}}` is data", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub, { readOnly: true });
		// The hook installs nothing there, so there is no handler to fire.
		expect(stub.handlers.move).toBeUndefined();
		hoverAt(stub, 4);
		expect(setHoveredToken).not.toHaveBeenCalled();
	});

	it("closes the tooltip when the popover opens over the same token", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);

		hoverAt(stub, 8);
		metaClickAt(stub, 8);
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);
		expect(openTokenEditor).toHaveBeenCalledTimes(1);
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
