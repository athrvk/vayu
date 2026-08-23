/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Send and Load Test are told apart by Shift, so Shift has to be compared.
 *
 * The obvious implementation - "is the modifier down and is this Enter?" -
 * makes `mod+shift+Enter` satisfy Send as well as Load Test, and both fire.
 * That is the single failure a modifier-distinguished pair cannot have, and it
 * is invisible in casual use because Send usually wins and looks right.
 *
 * Send predates this and had always been `mod+Enter` with no `shift` check at
 * all, which is exactly the shape that breaks when a second chord is added
 * beside it.
 */

import { describe, it, expect } from "vitest";
import {
	SEND_CHORD,
	LOAD_TEST_CHORD,
	SAVE_CHORD,
	CLOSE_TAB_CHORD,
	TOGGLE_DRAWER_CHORD,
	TOGGLE_CONTEXT_BAR_CHORD,
	SETTINGS_CHORD,
	DRAWER_VIEW_CHORDS,
	TAB_CHORDS,
	matchesChord,
} from "./shortcuts";

/** A KeyboardEvent-shaped literal - the fields `matchesChord` reads. */
function ev(
	key: string,
	mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}
) {
	return {
		key,
		code: mods.code ?? "",
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt,
	};
}

describe("send", () => {
	it("fires on Cmd+Enter", () => {
		expect(matchesChord(ev("Enter", { meta: true }), SEND_CHORD)).toBe(true);
	});

	it("fires on Ctrl+Enter, so the same code serves every platform", () => {
		expect(matchesChord(ev("Enter", { ctrl: true }), SEND_CHORD)).toBe(true);
	});

	it("does not fire on a bare Enter", () => {
		expect(matchesChord(ev("Enter"), SEND_CHORD)).toBe(false);
	});

	it("does not fire when Shift is held", () => {
		// The collision. Without a strict comparison this is `true` and Send
		// fires alongside the load test.
		expect(matchesChord(ev("Enter", { meta: true, shift: true }), SEND_CHORD)).toBe(false);
	});

	it("does not fire when Alt is held", () => {
		expect(matchesChord(ev("Enter", { meta: true, alt: true }), SEND_CHORD)).toBe(false);
	});
});

describe("load test", () => {
	it("fires on Cmd+Shift+Enter", () => {
		expect(matchesChord(ev("Enter", { meta: true, shift: true }), LOAD_TEST_CHORD)).toBe(true);
	});

	it("fires on Ctrl+Shift+Enter", () => {
		expect(matchesChord(ev("Enter", { ctrl: true, shift: true }), LOAD_TEST_CHORD)).toBe(true);
	});

	it("does not fire without Shift", () => {
		expect(matchesChord(ev("Enter", { meta: true }), LOAD_TEST_CHORD)).toBe(false);
	});

	it("does not fire without the modifier", () => {
		expect(matchesChord(ev("Enter", { shift: true }), LOAD_TEST_CHORD)).toBe(false);
	});
});

describe("the two never both fire", () => {
	it.each([
		["Cmd+Enter", ev("Enter", { meta: true })],
		["Ctrl+Enter", ev("Enter", { ctrl: true })],
		["Cmd+Shift+Enter", ev("Enter", { meta: true, shift: true })],
		["Ctrl+Shift+Enter", ev("Enter", { ctrl: true, shift: true })],
		["bare Enter", ev("Enter")],
		["Cmd+Alt+Enter", ev("Enter", { meta: true, alt: true })],
	])("%s matches at most one chord", (_label, event) => {
		const hits = [SEND_CHORD, LOAD_TEST_CHORD].filter((c) => matchesChord(event, c));
		expect(hits.length).toBeLessThanOrEqual(1);
	});
});

describe("the chords the buttons advertise", () => {
	it("are the ones the handler listens for", () => {
		// The label and the handler read the same constant. Asserting the shape
		// keeps a future edit to one from being an edit to only one.
		expect(SEND_CHORD).toEqual({ mod: true, key: "↵", label: "Send request" });
		expect(LOAD_TEST_CHORD).toEqual({
			mod: true,
			shift: true,
			key: "↵",
			label: "Start a load test",
		});
	});

	it("map the display glyph to the real key name", () => {
		// `formatChord` wants "↵" to render; `KeyboardEvent.key` says "Enter".
		expect(matchesChord(ev("Enter", { meta: true }), { mod: true, key: "↵" })).toBe(true);
	});
});

/**
 * The Shell's fourteen hand-rolled bindings joined this registry in #938,
 * bringing two real misfires with them that only a strict matcher fixes.
 */
describe("AltGr does not press the Shell's chords", () => {
	// On many European Windows layouts AltGr *is* Ctrl+Alt, so typing `@`, `€`
	// or `\` reports ctrlKey and altKey together. The hand-rolled map read only
	// `ctrlKey` and saved, closed the tab, toggled the drawer.
	it.each([
		["save", "s", SAVE_CHORD],
		["close tab", "w", CLOSE_TAB_CHORD],
		["toggle drawer", "b", TOGGLE_DRAWER_CHORD],
		["toggle context bar", "i", TOGGLE_CONTEXT_BAR_CHORD],
	])("%s ignores Ctrl+Alt", (_label, key, chord) => {
		expect(matchesChord(ev(key, { ctrl: true }), chord)).toBe(true);
		expect(matchesChord(ev(key, { ctrl: true, alt: true }), chord)).toBe(false);
	});
});

describe("the tab chords are physical, not typographic", () => {
	// AZERTY's unshifted digit row produces `&é"'(-è_çà`; the key that says "1"
	// says it only with Shift held, and that press belongs to the shifted
	// chords. The position is what is stable, so the position is what is bound.
	it("matches an AZERTY press, whose key is not a digit at all", () => {
		expect(matchesChord(ev("&", { ctrl: true, code: "Digit1" }), TAB_CHORDS[0])).toBe(true);
		expect(matchesChord(ev("é", { ctrl: true, code: "Digit2" }), TAB_CHORDS[1])).toBe(true);
	});

	it("matches a QWERTY press, whose key happens to be the digit", () => {
		expect(matchesChord(ev("1", { ctrl: true, code: "Digit1" }), TAB_CHORDS[0])).toBe(true);
	});

	it("does not match a digit produced from another position", () => {
		// The numeric keypad: the chord is ⌘1 on the top row and nothing else.
		expect(matchesChord(ev("1", { ctrl: true, code: "Numpad1" }), TAB_CHORDS[0])).toBe(false);
	});

	it("still needs the modifier, and refuses Shift and Alt", () => {
		expect(matchesChord(ev("1", { code: "Digit1" }), TAB_CHORDS[0])).toBe(false);
		expect(
			matchesChord(ev("1", { ctrl: true, shift: true, code: "Digit1" }), TAB_CHORDS[0])
		).toBe(false);
		expect(
			matchesChord(ev("1", { ctrl: true, alt: true, code: "Digit1" }), TAB_CHORDS[0])
		).toBe(false);
	});

	it("labels each one with the digit it displays", () => {
		expect(TAB_CHORDS).toHaveLength(9);
		expect(TAB_CHORDS.map((c) => c.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
	});
});

describe("no press matches two chords", () => {
	const ALL = [
		SEND_CHORD,
		LOAD_TEST_CHORD,
		SAVE_CHORD,
		CLOSE_TAB_CHORD,
		TOGGLE_DRAWER_CHORD,
		TOGGLE_CONTEXT_BAR_CHORD,
		...Object.values(DRAWER_VIEW_CHORDS),
		...TAB_CHORDS,
	];

	// ⇧⌘S is Services and ⌘S is Save - the pair the old shifted branch had to be
	// written around, by returning early for every shifted press.
	it.each(["s", "w", "b", "i", "e", "h", "u", ",", "Enter"])(
		"Ctrl+%s, shifted or not, matches at most one",
		(key) => {
			for (const shift of [false, true]) {
				const hits = ALL.filter((c) => matchesChord(ev(key, { ctrl: true, shift }), c));
				expect(hits.length).toBeLessThanOrEqual(1);
			}
		}
	);

	it("gives Settings the one chord it shares with its drawer view", () => {
		// Deliberate, and the reason the Shell answers ⌘, before it walks the
		// drawer table: opening the Settings tab brings its drawer view along.
		expect(DRAWER_VIEW_CHORDS.settings).toBe(SETTINGS_CHORD);
	});
});
