/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Both platform branches, neither of them the host's.
 *
 * This file used to assert `isMac === false` and call that "the test
 * environment". That was true only by accident: jsdom reports a Linux-ish
 * user-agent, so the Windows/Linux branch was the only one ever exercised, on
 * every machine including a Mac. Moving the file to the `node` environment
 * removed the accident - Node exposes a real global `navigator`, so on a macOS
 * runner `navigator.platform` is "MacIntel" and the assertion failed. CI caught
 * it on macOS while Windows and Linux stayed green, which is exactly the shape
 * of bug a cross-platform project needs its tests not to have.
 *
 * `isMac` and `modKey` are module-level consts evaluated at import, so each
 * case resets the module registry and re-imports under a stubbed navigator.
 * That is also what lets the macOS branch be tested at all: it never was.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

type Platform = typeof import("./platform");

/** Load `platform.ts` fresh, with `navigator.platform` forced to `value`. */
async function loadWithPlatform(value: string): Promise<Platform> {
	vi.resetModules();
	vi.stubGlobal("navigator", { platform: value, userAgent: value });
	return import("./platform");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("platform detection", () => {
	it.each(["MacIntel", "MacPPC", "macOS"])("treats %s as macOS", async (value) => {
		const { isMac } = await loadWithPlatform(value);
		expect(isMac).toBe(true);
	});

	it.each(["Win32", "Windows", "Linux x86_64"])("treats %s as not macOS", async (value) => {
		const { isMac } = await loadWithPlatform(value);
		expect(isMac).toBe(false);
	});

	it("prefers the platform Electron reports over the user agent", async () => {
		// The renderer runs inside Electron in production, where the main process
		// is authoritative. The UA fallback exists only for dev in a browser.
		vi.resetModules();
		vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Win32" });
		vi.stubGlobal("window", { electronAPI: { platform: "darwin" } });
		const { isMac } = await import("./platform");
		expect(isMac).toBe(true);
	});
});

describe("modifier rendering on macOS", () => {
	it("uses the glyph style", async () => {
		const { modKey, formatChord } = await loadWithPlatform("MacIntel");
		expect(modKey).toBe("⌘");
		expect(formatChord({ mod: true, key: "S" })).toBe("⌘S");
		expect(formatChord({ mod: true, shift: true, key: "E" })).toBe("⇧⌘E");
		expect(formatChord({ mod: true, alt: true, key: "I" })).toBe("⌥⌘I");
		expect(formatChord({ key: "↵" })).toBe("↵");
	});
});

describe("modifier rendering off macOS", () => {
	it("uses the word style", async () => {
		const { modKey, formatChord } = await loadWithPlatform("Win32");
		expect(modKey).toBe("Ctrl");
		expect(formatChord({ mod: true, key: "S" })).toBe("Ctrl+S");
		expect(formatChord({ mod: true, shift: true, key: "E" })).toBe("Ctrl+Shift+E");
		expect(formatChord({ mod: true, alt: true, key: "I" })).toBe("Ctrl+Alt+I");
		expect(formatChord({ key: "↵" })).toBe("↵");
	});
});

describe("the two styles stay distinguishable", () => {
	it("renders the same chord differently on each platform", async () => {
		const mac = await loadWithPlatform("MacIntel");
		const macOut = mac.formatChord({ mod: true, shift: true, key: "E" });
		const win = await loadWithPlatform("Win32");
		const winOut = win.formatChord({ mod: true, shift: true, key: "E" });

		expect(macOut).not.toBe(winOut);
		// macOS convention is tight glyphs; elsewhere it is "+"-joined words.
		expect(macOut).not.toContain("+");
		expect(winOut).toContain("+");
	});
});
