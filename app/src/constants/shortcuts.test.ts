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
import { SEND_CHORD, LOAD_TEST_CHORD, matchesChord } from "./shortcuts";

/** A KeyboardEvent-shaped literal - the fields `matchesChord` reads. */
function ev(
	key: string,
	mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
) {
	return {
		key,
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
		expect(SEND_CHORD).toEqual({ mod: true, key: "↵" });
		expect(LOAD_TEST_CHORD).toEqual({ mod: true, shift: true, key: "↵" });
	});

	it("map the display glyph to the real key name", () => {
		// `formatChord` wants "↵" to render; `KeyboardEvent.key` says "Enter".
		expect(matchesChord(ev("Enter", { meta: true }), { mod: true, key: "↵" })).toBe(true);
	});
});
