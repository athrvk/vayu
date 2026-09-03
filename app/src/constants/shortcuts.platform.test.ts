/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `mod: "strict"` - the palette's ⌘K, and the only chord that has it.
 *
 * The lenient modifier is right for everything else: one definition, either ⌘
 * or Ctrl, whichever the platform's users press. It was wrong for this one
 * because the palette listens on the *capture* phase, so on macOS it took
 * Ctrl+K - Cocoa's kill-to-end-of-line, implemented by every text field and by
 * Monaco as `deleteAllRight` - before the focused control saw it (#938).
 *
 * Both branches, per the repo rule, and neither of them the host's: `isMac` is
 * a module-level const evaluated at import, so each case resets the module
 * registry and re-imports under a stubbed platform, the way `platform.test.ts`
 * does. Asserting only the host's branch would have left the mac half - the
 * whole bug - untested on Linux and Windows CI.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

type Shortcuts = typeof import("./shortcuts");

/** Load the registry fresh, with the platform forced. */
async function loadOn(platform: "darwin" | "linux"): Promise<Shortcuts> {
	vi.resetModules();
	vi.stubGlobal("window", { electronAPI: { platform } });
	return import("./shortcuts");
}

function press(key: string, mods: { meta?: boolean; ctrl?: boolean } = {}) {
	return {
		key,
		code: "",
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: false,
		altKey: false,
	};
}

/** A press matched by `code`, which the navigation and digit chords are. */
function pressCode(
	code: string,
	mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}
) {
	return {
		key: "",
		code,
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("the palette chord on macOS", () => {
	it("takes ⌘K", async () => {
		const { PALETTE_CHORD, matchesChord } = await loadOn("darwin");
		expect(matchesChord(press("k", { meta: true }), PALETTE_CHORD)).toBe(true);
	});

	it("leaves Ctrl+K to the focused control", async () => {
		const { PALETTE_CHORD, matchesChord } = await loadOn("darwin");
		expect(matchesChord(press("k", { ctrl: true }), PALETTE_CHORD)).toBe(false);
	});

	it("does not take ⌘K with Ctrl also held", async () => {
		const { PALETTE_CHORD, matchesChord } = await loadOn("darwin");
		expect(matchesChord(press("k", { meta: true, ctrl: true }), PALETTE_CHORD)).toBe(false);
	});
});

describe("the palette chord off macOS", () => {
	it("takes Ctrl+K", async () => {
		const { PALETTE_CHORD, matchesChord } = await loadOn("linux");
		expect(matchesChord(press("k", { ctrl: true }), PALETTE_CHORD)).toBe(true);
	});

	it("does not take Super+K, which is the window manager's", async () => {
		const { PALETTE_CHORD, matchesChord } = await loadOn("linux");
		expect(matchesChord(press("k", { meta: true }), PALETTE_CHORD)).toBe(false);
	});
});

/**
 * The other platform-forked pair, and the one where the fork is the *chord*
 * rather than the modifier: each platform's browsers bind a different key for
 * Back, and the other platform's binding is dead or harmful there (#1245).
 */
describe("the navigation chords on macOS", () => {
	it("take ⌘[ and ⌘]", async () => {
		const { GO_BACK_CHORD, GO_FORWARD_CHORD, matchesChord } = await loadOn("darwin");
		expect(matchesChord(pressCode("BracketLeft", { meta: true }), GO_BACK_CHORD)).toBe(true);
		expect(matchesChord(pressCode("BracketRight", { meta: true }), GO_FORWARD_CHORD)).toBe(
			true
		);
	});

	it("leave ⌥← to the caret, which is what it moves there", async () => {
		const { GO_BACK_CHORD, matchesChord } = await loadOn("darwin");
		expect(matchesChord(pressCode("ArrowLeft", { alt: true }), GO_BACK_CHORD)).toBe(false);
	});

	it("do not collide with the tab chords, which are the shifted pair", async () => {
		const { GO_BACK_CHORD, NEXT_TAB_CHORD, matchesChord } = await loadOn("darwin");
		const shifted = pressCode("BracketRight", { meta: true, shift: true });
		expect(matchesChord(shifted, NEXT_TAB_CHORD)).toBe(true);
		expect(matchesChord(shifted, GO_BACK_CHORD)).toBe(false);
	});
});

describe("the navigation chords off macOS", () => {
	it("take Alt+← and Alt+→, what every browser binds there", async () => {
		const { GO_BACK_CHORD, GO_FORWARD_CHORD, matchesChord } = await loadOn("linux");
		expect(matchesChord(pressCode("ArrowLeft", { alt: true }), GO_BACK_CHORD)).toBe(true);
		expect(matchesChord(pressCode("ArrowRight", { alt: true }), GO_FORWARD_CHORD)).toBe(true);
	});

	it("do not take a bare arrow, which belongs to whatever has focus", async () => {
		const { GO_BACK_CHORD, matchesChord } = await loadOn("linux");
		expect(matchesChord(pressCode("ArrowLeft"), GO_BACK_CHORD)).toBe(false);
	});

	it("do not take Ctrl+[, which is not a navigation there", async () => {
		const { GO_BACK_CHORD, matchesChord } = await loadOn("linux");
		expect(matchesChord(pressCode("BracketLeft", { ctrl: true }), GO_BACK_CHORD)).toBe(false);
	});
});

describe("the lenient modifier is unaffected on both", () => {
	// The exception is one chord. Save still answers whichever modifier the
	// platform's users press, which is the whole point of `mod: true`.
	it.each(["darwin", "linux"] as const)("save takes ⌘ and Ctrl on %s", async (platform) => {
		const { SAVE_CHORD, matchesChord } = await loadOn(platform);
		expect(matchesChord(press("s", { meta: true }), SAVE_CHORD)).toBe(true);
		expect(matchesChord(press("s", { ctrl: true }), SAVE_CHORD)).toBe(true);
	});
});
