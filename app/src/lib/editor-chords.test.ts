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
 * Send, from inside an editor.
 *
 * Monaco owns Enter, and the window handler agrees with it - `ownsEnterKey`
 * excludes editors on purpose. The result was that ⌘↵ inserted a newline in the
 * body, GraphQL and script panes (#938), which is where the palette's own
 * comment says users spend most of their time. No `addCommand` existed anywhere
 * in the app.
 *
 * The bridge re-dispatches the chord instead of calling `executeRequest`, so
 * every gate the window handler holds still applies; these cases assert the
 * shape of what it sends, and `RequestBuilderLayout.send-chord.test.tsx`
 * asserts that the handler acts on it.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type * as Monaco from "monaco-editor";
import {
	chordKeybinding,
	dispatchChord,
	focusAfterEditor,
	registerEditorChords,
} from "./editor-chords";
import {
	SEND_CHORD,
	LOAD_TEST_CHORD,
	SAVE_CHORD,
	SETTINGS_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	LEAVE_EDITOR_CHORD,
} from "@/constants/shortcuts";

/** The two enums the bridge reads, with Monaco's real values. */
const monaco = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
} as unknown as typeof Monaco;

/** An editor stub: the two methods the bridge calls, and nothing else. */
function fakeEditor(container?: HTMLElement) {
	const addCommand = vi.fn();
	const editor = {
		addCommand,
		getContainerDomNode: () => container ?? document.createElement("div"),
	} as unknown as Monaco.editor.IStandaloneCodeEditor;
	return { editor, addCommand };
}

describe("chordKeybinding", () => {
	it("gives Send the CtrlCmd+Enter binding Monaco expects", () => {
		expect(chordKeybinding(SEND_CHORD, monaco)).toBe(2048 | 3);
	});

	it("adds Shift for the load test, so the pair stays distinct in the editor too", () => {
		expect(chordKeybinding(LOAD_TEST_CHORD, monaco)).toBe(2048 | 1024 | 3);
	});

	it("maps letters and digits off their enum bases", () => {
		expect(chordKeybinding(SAVE_CHORD, monaco)).toBe(2048 | (31 + 18));
		expect(chordKeybinding({ mod: true, key: "1" }, monaco)).toBe(2048 | 22);
	});

	it("returns null for a key it has no code for, rather than guessing", () => {
		// A guess binds a chord the user never asked for and looks like it
		// worked, which is the failure this whole issue is about.
		expect(chordKeybinding(SETTINGS_CHORD, monaco)).toBeNull();
	});
});

describe("dispatchChord", () => {
	it("re-dispatches on the body, where no editor guard covers it", () => {
		const seen: KeyboardEvent[] = [];
		const listener = (e: Event) => seen.push(e as KeyboardEvent);
		window.addEventListener("keydown", listener);
		dispatchChord(SEND_CHORD);
		window.removeEventListener("keydown", listener);

		expect(seen).toHaveLength(1);
		expect(seen[0].target).toBe(document.body);
		expect(seen[0].key).toBe("Enter");
		// One modifier, the platform's own: a synthetic event carrying both
		// would fail a `mod: "strict"` chord the real press satisfies.
		expect(seen[0].ctrlKey !== seen[0].metaKey).toBe(true);
		expect(seen[0].shiftKey).toBe(false);
		expect(seen[0].altKey).toBe(false);
	});

	it("carries Shift for the load test", () => {
		const seen: KeyboardEvent[] = [];
		const listener = (e: Event) => seen.push(e as KeyboardEvent);
		window.addEventListener("keydown", listener);
		dispatchChord(LOAD_TEST_CHORD);
		window.removeEventListener("keydown", listener);

		expect(seen[0].shiftKey).toBe(true);
	});
});

describe("registerEditorChords", () => {
	it("binds both Enter chords on the editor it is given", () => {
		const { editor, addCommand } = fakeEditor();
		registerEditorChords(editor, monaco);
		expect(addCommand.mock.calls.map((c) => c[0])).toContainEqual(2048 | 3);
		expect(addCommand.mock.calls.map((c) => c[0])).toContainEqual(2048 | 1024 | 3);
	});

	it("binds the context-bar toggle, which Monaco claims for triggerSuggest", () => {
		// The reason this one is here at all and S, W and B are not: Monaco has
		// CtrlCmd+I as a secondary `triggerSuggest` binding and stops the event,
		// so ⌘I never reached `Shell` from inside an editor. Drop it from
		// `BRIDGED_CHORDS` and this case is the only thing that notices.
		const { editor, addCommand } = fakeEditor();
		registerEditorChords(editor, monaco);
		expect(addCommand.mock.calls.map((c) => c[0])).toContainEqual(
			chordKeybinding(TOGGLE_CONTEXT_BAR_CHORD, monaco)
		);
	});

	it("binds the way out of the Tab trap", () => {
		const { editor, addCommand } = fakeEditor();
		registerEditorChords(editor, monaco);
		expect(addCommand.mock.calls.map((c) => c[0])).toContainEqual(
			chordKeybinding(LEAVE_EDITOR_CHORD, monaco)
		);
	});

	it("dispatches the chord when Monaco runs the command", () => {
		const { editor, addCommand } = fakeEditor();
		registerEditorChords(editor, monaco);
		const seen: KeyboardEvent[] = [];
		const listener = (e: Event) => seen.push(e as KeyboardEvent);
		window.addEventListener("keydown", listener);
		addCommand.mock.calls[0][1]();
		window.removeEventListener("keydown", listener);

		expect(seen).toHaveLength(1);
		expect(seen[0].key).toBe("Enter");
		expect(seen[0].shiftKey).toBe(false);
	});

	it("moves focus out of the editor when the leave command runs", () => {
		const container = document.createElement("div");
		const after = document.createElement("button");
		document.body.append(container, after);

		const { editor, addCommand } = fakeEditor(container);
		registerEditorChords(editor, monaco);
		const leave = addCommand.mock.calls.find(
			(c) => c[0] === chordKeybinding(LEAVE_EDITOR_CHORD, monaco)
		);
		leave?.[1]();

		expect(document.activeElement).toBe(after);
	});
});

/**
 * The exit itself.
 *
 * Monaco's Tab handling cannot run in jsdom, so what is testable is where focus
 * lands - which is the half that can silently regress into `<body>` (#1218) or
 * back into the editor it just left.
 */
describe("focusAfterEditor", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	/** An editor container with `before`/`after` siblings around it. */
	function scene(): { container: HTMLElement; before: HTMLElement; after: HTMLElement } {
		const before = document.createElement("button");
		before.textContent = "before";
		const container = document.createElement("div");
		const inside = document.createElement("textarea");
		container.append(inside);
		const after = document.createElement("button");
		after.textContent = "after";
		document.body.append(before, container, after);
		return { container, before, after };
	}

	it("lands on the next focusable element after the editor", () => {
		const { container, after } = scene();
		expect(focusAfterEditor(container)).toBe(true);
		expect(document.activeElement).toBe(after);
	});

	it("never lands inside the editor, which the next Tab would walk back into", () => {
		const { container } = scene();
		focusAfterEditor(container);
		expect(container.contains(document.activeElement)).toBe(false);
	});

	it("goes backwards when the editor is the last thing on the page", () => {
		const { container, before, after } = scene();
		after.remove();
		expect(focusAfterEditor(container)).toBe(true);
		expect(document.activeElement).toBe(before);
	});

	it("skips a disabled control, which Tab skips too", () => {
		const { container, after } = scene();
		after.setAttribute("disabled", "");
		const next = document.createElement("a");
		next.href = "#x";
		document.body.append(next);
		focusAfterEditor(container);
		expect(document.activeElement).toBe(next);
	});

	it("skips anything hidden from assistive technology", () => {
		const { container, after } = scene();
		after.setAttribute("aria-hidden", "true");
		const next = document.createElement("button");
		document.body.append(next);
		focusAfterEditor(container);
		expect(document.activeElement).toBe(next);
	});

	it("reports that focus did not move when there is nowhere to move it", () => {
		const container = document.createElement("div");
		document.body.append(container);
		expect(focusAfterEditor(container)).toBe(false);
	});

	it("does nothing without a container, rather than throwing at the caller", () => {
		expect(focusAfterEditor(null)).toBe(false);
	});
});
