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
 * What one editor does with the tokens in its text: paints them, opens the
 * shared popover over the one the pointer rests on (issue #1220 hover
 * redesign) - unfocused for an editable token, the read-only `TokenHoverCard`
 * for a run-time one - and binds the chord that opens the one under the caret,
 * focused.
 *
 * Driven against a Monaco stub rather than a real editor - the API surface used
 * here is six methods, and jsdom has no layout for the real one to measure. The
 * three "does nothing" cases are the load-bearing ones: a response viewer, a
 * language with no matcher (`RawRequestResponse`'s `http`, standing in for
 * anything `VARIABLE_TOKEN_MATCHERS` has not been taught) and an editor with
 * no provider above it must come out of this hook exactly as they went in.
 *
 * Since issue #1220's script support, `javascript` is no longer one of those
 * three - it has its own matcher (`lib/script-variable-tokens.ts`) - so the
 * cases below cover a script's per-accessor scoping, its `replaceIn(...)`
 * templates and its bare, muted, never-editable mentions too.
 *
 * A click opens nothing here any more - there is no `onMouseDown` handler left
 * to test - so every case that used to open a token with a ⌘-click now does it
 * through the hover delay or the edit chord instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type * as Monaco from "monaco-editor";
import type { MonacoApi } from "@/lib/monaco-api";
import type { ResolvedVariable, VariableOrigin } from "@/types";
import { classifyScriptToken } from "@/lib/variable-token-kind";
import { TIMING } from "@/config/timing";
import { EditorVariableTokensContext, type EditorVariableTokensValue } from "./context";
import { useEditorVariableTokens } from "./useEditorVariableTokens";

const variables: Record<string, ResolvedVariable> = {};
let origins: VariableOrigin[] = [];

const openTokenEditor = vi.fn();
const closeTokenEditor = vi.fn();
const setHoveredToken = vi.fn();

const contextValue: EditorVariableTokensValue = {
	classify: (name, scriptHint) =>
		classifyScriptToken(name, scriptHint, {
			variables,
			getVariableOrigins: () => origins,
		}),
	getVariableOrigins: () => origins,
	openTokenEditor,
	closeTokenEditor,
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
	// Through `initialProps`, so a case can hand the mounted editor a different
	// language or `readOnly` the way a body-mode switch would.
	const rendered = renderHook(
		(props: { language: string; readOnly: boolean }) => useEditorVariableTokens(props),
		{
			initialProps: { language, readOnly },
			wrapper: ({ children }) =>
				withProvider ? (
					<EditorVariableTokensContext.Provider value={contextValue}>
						{children}
					</EditorVariableTokensContext.Provider>
				) : (
					<>{children}</>
				),
		}
	);
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
		// The listener `trackHoverContent` attaches is scheduled a tick after the
		// open, via a real (non-fake) `setTimeout(0)` macrotask boundary - flushed
		// by letting fake timers past it too.
		vi.advanceTimersByTime(0);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	openTokenEditor.mockClear();
	closeTokenEditor.mockClear();
	setHoveredToken.mockClear();
	for (const key of Object.keys(variables)) delete variables[key];
	origins = [];
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

	describe("hovering an editable token", () => {
		it("opens the shared popover, unfocused, over the token's own rectangle", () => {
			variables.baseUrl = { value: "https://x", scope: "environment" };
			const stub = stubEditor(["GET {{baseUrl}}"]);
			mount(stub);

			hoverAt(stub, 8);
			expect(openTokenEditor).toHaveBeenCalledTimes(1);
			expect(openTokenEditor.mock.calls[0][0]).toMatchObject({
				name: "baseUrl",
				focus: false,
				rect: { left: 10 + 5 * 8, top: 24, height: 18 },
			});
			// Never the read-only tooltip - the two are mutually exclusive.
			expect(setHoveredToken).not.toHaveBeenCalled();
		});

		it("reads one line per mouse move, not the whole model", () => {
			variables.baseUrl = { value: "https://x", scope: "environment" };
			const stub = stubEditor(["GET {{baseUrl}}"]);
			mount(stub);

			// The paint at install walks the model; the pointer must not.
			stub.lineCount.mockClear();
			hoverAt(stub, 8);
			expect(openTokenEditor).toHaveBeenCalledTimes(1);
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
			expect(openTokenEditor).not.toHaveBeenCalled();
		});

		it("stays open while the pointer moves inside the token it is showing", () => {
			variables.baseUrl = { value: "https://x", scope: "environment" };
			const stub = stubEditor(["GET {{baseUrl}}"]);
			mount(stub);

			hoverAt(stub, 8);
			hoverAt(stub, 10);
			// One open, and no take-down in between: re-arming the timer per character
			// is a popover that never opens while the hand is not perfectly still.
			expect(openTokenEditor).toHaveBeenCalledTimes(1);
			expect(closeTokenEditor).not.toHaveBeenCalled();
		});

		/**
		 * The leave-grace (issue #1220 hover redesign). A pointer that just moved
		 * off the token - toward the popover's own content, to click its value
		 * field or read a shadowed definition - must not have the popover pulled
		 * out from under it the instant it leaves the token.
		 */
		describe("the leave-grace before it closes", () => {
			it("does not close the instant the pointer leaves the token", () => {
				variables.baseUrl = { value: "https://x", scope: "environment" };
				const stub = stubEditor(["GET {{baseUrl}}"]);
				mount(stub);

				hoverAt(stub, 8);
				act(() => {
					stub.handlers.move?.({
						target: { position: { lineNumber: 1, column: 1 } },
					} as unknown as Monaco.editor.IEditorMouseEvent);
				});
				// Mutation check: close on the leave itself and this fails.
				expect(closeTokenEditor).not.toHaveBeenCalled();
			});

			it("closes once the grace period actually runs out", () => {
				variables.baseUrl = { value: "https://x", scope: "environment" };
				const stub = stubEditor(["GET {{baseUrl}}"]);
				mount(stub);

				hoverAt(stub, 8);
				act(() => {
					stub.handlers.move?.({
						target: { position: { lineNumber: 1, column: 1 } },
					} as unknown as Monaco.editor.IEditorMouseEvent);
					vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS);
				});
				expect(closeTokenEditor).toHaveBeenCalledTimes(1);
			});

			it("cancels the close when the pointer lands back on the token in time", () => {
				variables.baseUrl = { value: "https://x", scope: "environment" };
				const stub = stubEditor(["GET {{baseUrl}}"]);
				mount(stub);

				hoverAt(stub, 8);
				act(() => {
					stub.handlers.move?.({
						target: { position: { lineNumber: 1, column: 1 } },
					} as unknown as Monaco.editor.IEditorMouseEvent);
					vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS / 2);
					stub.handlers.move?.({
						target: { position: { lineNumber: 1, column: 8 } },
					} as unknown as Monaco.editor.IEditorMouseEvent);
					vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS);
				});
				expect(closeTokenEditor).not.toHaveBeenCalled();
			});

			it("takes the grace, not an immediate close, when the pointer leaves the editor entirely", () => {
				variables.baseUrl = { value: "https://x", scope: "environment" };
				const stub = stubEditor(["GET {{baseUrl}}"]);
				mount(stub);

				hoverAt(stub, 8);
				act(() => stub.handlers.leave?.());
				expect(closeTokenEditor).not.toHaveBeenCalled();

				act(() => vi.advanceTimersByTime(TIMING.TOOLTIP_DELAY_MS));
				expect(closeTokenEditor).toHaveBeenCalledTimes(1);
			});

			it("closes immediately on a scroll - the anchor rectangle is already stale", () => {
				variables.baseUrl = { value: "https://x", scope: "environment" };
				const stub = stubEditor(["GET {{baseUrl}}"]);
				mount(stub);

				hoverAt(stub, 8);
				act(() => stub.handlers.scroll?.());
				expect(closeTokenEditor).toHaveBeenCalledTimes(1);
			});
		});

		it("takes it down the moment the editor stops painting tokens at all", () => {
			variables.baseUrl = { value: "https://x", scope: "environment" };
			const stub = stubEditor(["GET {{baseUrl}}"]);
			const rendered = mount(stub);

			hoverAt(stub, 8);
			// A body mode that left the languages with a matcher, with the popover
			// still up - "http", `RawRequestResponse`'s own language, which (like
			// every language absent from `VARIABLE_TOKEN_MATCHERS`) paints nothing.
			act(() => rendered.rerender({ language: "http", readOnly: false }));
			expect(closeTokenEditor).toHaveBeenCalledTimes(1);
		});

		it("closes it on unmount, rather than leaving it hanging over whatever replaces the editor", () => {
			variables.baseUrl = { value: "https://x", scope: "environment" };
			const stub = stubEditor(["GET {{baseUrl}}"]);
			const rendered = mount(stub);

			hoverAt(stub, 8);
			act(() => rendered.unmount());
			expect(closeTokenEditor).toHaveBeenCalledTimes(1);
		});
	});

	describe("hovering a run-time token", () => {
		it("shows the read-only tooltip rather than opening the popover", () => {
			const stub = stubEditor(["{{$guid}}"]);
			mount(stub);

			hoverAt(stub, 4);
			expect(setHoveredToken).toHaveBeenCalledTimes(1);
			expect(setHoveredToken.mock.calls[0][0]).toMatchObject({ name: "$guid" });
			expect(openTokenEditor).not.toHaveBeenCalled();
		});

		it("takes the tooltip down off the token, on a scroll, and when the editor goes", () => {
			// A leading character so column 1 sits *outside* the token - unlike
			// `{{$guid}}` alone, where column 1 is its own first column.
			const stub = stubEditor(["z {{$guid}}"]);
			const rendered = mount(stub);

			hoverAt(stub, 6);
			act(() => {
				stub.handlers.move?.({
					target: { position: { lineNumber: 1, column: 1 } },
				} as unknown as Monaco.editor.IEditorMouseEvent);
			});
			expect(setHoveredToken).toHaveBeenLastCalledWith(null);

			hoverAt(stub, 6);
			act(() => stub.handlers.scroll?.());
			expect(setHoveredToken).toHaveBeenLastCalledWith(null);

			hoverAt(stub, 6);
			act(() => stub.handlers.leave?.());
			expect(setHoveredToken).toHaveBeenLastCalledWith(null);

			hoverAt(stub, 6);
			rendered.unmount();
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
	});

	it("closes the tooltip when the edit chord opens a different token", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["{{$guid}} {{baseUrl}}"]);
		mount(stub);

		hoverAt(stub, 4);
		expect(setHoveredToken).toHaveBeenCalledTimes(1);

		stub.moveCaretTo(15);
		act(() => stub.handlers.commands[0].run());
		expect(setHoveredToken).toHaveBeenLastCalledWith(null);
		expect(openTokenEditor).toHaveBeenCalledTimes(1);
	});

	it("leaves an editor with no matcher for its language alone", () => {
		// "http" - `RawRequestResponse`'s own language - has no entry in
		// `VARIABLE_TOKEN_MATCHERS`, the same as every response-viewer language.
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub, { language: "http" });
		expect(stub.decorations.set).not.toHaveBeenCalled();
	});

	describe("a script editor (issue #1220 script support)", () => {
		it("paints each accessor's argument, scoped to what it reads", () => {
			origins = [{ scope: "environment", value: "https://x", enabled: true, winner: true }];
			const stub = stubEditor(['pm.environment.get("baseUrl");']);
			mount(stub, { language: "javascript" });

			expect(stub.decorations.set).toHaveBeenCalledTimes(1);
			const painted = stub.decorations.set.mock.calls[0][0] as Array<{
				options: { inlineClassName: string };
			}>;
			// Resolved from the accessor's own scope - `variable-token-kind.test.ts`
			// pins the classification itself; this pins that the paint reaches it.
			expect(painted[0].options.inlineClassName).toBe("vayu-variable-token-resolved");
		});

		it("paints a replaceIn(...) template like a body-language token", () => {
			variables.host = { value: "https://x", scope: "environment" };
			const stub = stubEditor(['pm.variables.replaceIn("{{host}}");']);
			mount(stub, { language: "javascript" });

			const painted = stub.decorations.set.mock.calls[0][0] as Array<{
				options: { inlineClassName: string };
			}>;
			expect(painted[0].options.inlineClassName).toBe("vayu-variable-token-resolved");
		});

		it("paints a bare {{name}} muted, whatever the name would otherwise resolve to", () => {
			variables.host = { value: "https://x", scope: "environment" };
			const stub = stubEditor(['const u = "{{host}}";']);
			mount(stub, { language: "javascript" });

			const painted = stub.decorations.set.mock.calls[0][0] as Array<{
				options: { inlineClassName: string };
			}>;
			expect(painted[0].options.inlineClassName).toBe("vayu-variable-token-runtime");
		});

		it("ignores a setter and a name inside a comment", () => {
			const stub = stubEditor([
				'pm.environment.set("baseUrl", "x"); // pm.environment.get("ignored")',
			]);
			mount(stub, { language: "javascript" });
			expect(stub.decorations.set).toHaveBeenCalledWith([]);
		});

		it("shows the not-interpolated note for a bare token, with no edit action", () => {
			const stub = stubEditor(['const u = "{{host}}";']);
			mount(stub, { language: "javascript" });

			hoverAt(stub, 12);
			expect(setHoveredToken).toHaveBeenCalledTimes(1);
			expect(setHoveredToken.mock.calls[0][0]).toMatchObject({
				name: "host",
				scriptHint: { via: "bare" },
			});
			expect(openTokenEditor).not.toHaveBeenCalled();
		});

		it("never opens a popover for a bare template, even via the edit chord", () => {
			const stub = stubEditor(['const u = "{{host}}";']);
			mount(stub, { language: "javascript" });

			stub.moveCaretTo(12);
			stub.handlers.commands[0].run();
			expect(openTokenEditor).not.toHaveBeenCalled();
		});

		it("opens a real accessor read, over its own argument", () => {
			origins = [{ scope: "environment", value: "https://x", enabled: true, winner: true }];
			const stub = stubEditor(['pm.environment.get("baseUrl");']);
			mount(stub, { language: "javascript" });

			// Column 22 is inside "baseUrl" - see `script-variable-tokens.test.ts`
			// for the same offset math.
			stub.moveCaretTo(22);
			stub.handlers.commands[0].run();
			expect(openTokenEditor).toHaveBeenCalledTimes(1);
			expect(openTokenEditor.mock.calls[0][0]).toMatchObject({
				name: "baseUrl",
				focus: true,
				scriptHint: { via: "scope", scope: "environment" },
			});
		});
	});

	it("does nothing with no provider above it", () => {
		const stub = stubEditor(["{{baseUrl}}"]);
		mount(stub, { withProvider: false });
		expect(stub.decorations.set).not.toHaveBeenCalled();
		expect(stub.handlers.commands).toHaveLength(0);
	});

	it("opens nothing for a run-time token, even via the edit chord", () => {
		const stub = stubEditor(["{{$guid}}"]);
		mount(stub);
		stub.moveCaretTo(4);
		stub.handlers.commands[0].run();
		expect(openTokenEditor).not.toHaveBeenCalled();
	});

	it("binds the edit chord, and it reads the caret's own token, focused", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}} {{other}}"]);
		mount(stub);

		expect(stub.handlers.commands).toHaveLength(1);
		// ⇧⌘D - CtrlCmd | Shift | KeyD, as `chordKeybinding` composes it.
		expect(stub.handlers.commands[0].binding).toBe(2048 | 1024 | (31 + 3));

		stub.moveCaretTo(8);
		stub.handlers.commands[0].run();
		expect(openTokenEditor).toHaveBeenCalledTimes(1);
		expect(openTokenEditor.mock.calls[0][0]).toMatchObject({ name: "baseUrl", focus: true });

		// And nothing when the caret is not in a token at all.
		openTokenEditor.mockClear();
		stub.moveCaretTo(2);
		stub.handlers.commands[0].run();
		expect(openTokenEditor).not.toHaveBeenCalled();
	});

	it("hands focus back to the editor when a chord-opened popover closes", () => {
		variables.baseUrl = { value: "https://x", scope: "environment" };
		const stub = stubEditor(["GET {{baseUrl}}"]);
		mount(stub);
		stub.moveCaretTo(8);
		stub.handlers.commands[0].run();
		openTokenEditor.mock.calls[0][0].onClose();
		expect(stub.editor.focus).toHaveBeenCalled();
	});
});
