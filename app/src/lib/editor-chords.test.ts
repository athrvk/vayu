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

import { describe, it, expect, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { chordKeybinding, dispatchChord, registerEditorChords } from "./editor-chords";
import { SEND_CHORD, LOAD_TEST_CHORD, SAVE_CHORD, SETTINGS_CHORD } from "@/constants/shortcuts";

/** The two enums the bridge reads, with Monaco's real values. */
const monaco = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
	KeyCode: { Enter: 3, Digit1: 22, KeyA: 31 },
} as unknown as typeof Monaco;

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
		const addCommand = vi.fn();
		registerEditorChords(
			{ addCommand } as unknown as Monaco.editor.IStandaloneCodeEditor,
			monaco
		);
		expect(addCommand.mock.calls.map((c) => c[0])).toEqual([2048 | 3, 2048 | 1024 | 3]);
	});

	it("dispatches the chord when Monaco runs the command", () => {
		const addCommand = vi.fn();
		registerEditorChords(
			{ addCommand } as unknown as Monaco.editor.IStandaloneCodeEditor,
			monaco
		);
		const seen: KeyboardEvent[] = [];
		const listener = (e: Event) => seen.push(e as KeyboardEvent);
		window.addEventListener("keydown", listener);
		addCommand.mock.calls[0][1]();
		window.removeEventListener("keydown", listener);

		expect(seen).toHaveLength(1);
		expect(seen[0].key).toBe("Enter");
		expect(seen[0].shiftKey).toBe(false);
	});
});
