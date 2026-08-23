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

describe("the lenient modifier is unaffected on both", () => {
	// The exception is one chord. Save still answers whichever modifier the
	// platform's users press, which is the whole point of `mod: true`.
	it.each(["darwin", "linux"] as const)("save takes ⌘ and Ctrl on %s", async (platform) => {
		const { SAVE_CHORD, matchesChord } = await loadOn(platform);
		expect(matchesChord(press("s", { meta: true }), SAVE_CHORD)).toBe(true);
		expect(matchesChord(press("s", { ctrl: true }), SAVE_CHORD)).toBe(true);
	});
});
