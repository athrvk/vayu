/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The menu and Settings > Keyboard shortcuts cannot disagree (#3325).
 *
 * `menu-accelerators.ts` writes each accelerator as a plain chord because this
 * process cannot import the renderer's `constants/shortcuts.ts`. This test is
 * the bridge: it loads the real chords and requires the accelerator the menu
 * registers to be what `chordAccelerator` makes of the chord the panel prints.
 * main.ts cannot be run (it starts the app at import), so a scan of
 * `createMenu` holds the other half: every accelerator in it comes from the
 * table, none is a literal.
 *
 * `shortcuts.ts` forks on `isMac` at import, so each platform loads it afresh
 * under a stubbed one - nothing here asks which platform the host is.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chordAccelerator, menuAccelerators } from "./menu-accelerators.js";

type Shortcuts = typeof import("@/constants/shortcuts");

async function loadShortcutsOn(platform: "darwin" | "win32" | "linux"): Promise<Shortcuts> {
	vi.resetModules();
	vi.stubGlobal("window", { electronAPI: { platform } });
	return import("@/constants/shortcuts");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("chordAccelerator", () => {
	it("spells the primary modifier CmdOrCtrl, whether lenient or strict", () => {
		expect(chordAccelerator({ mod: true, key: "S" })).toBe("CmdOrCtrl+S");
		expect(chordAccelerator({ mod: "strict", key: "K" })).toBe("CmdOrCtrl+K");
	});

	it("orders the modifiers and leaves out the ones a chord lacks", () => {
		expect(chordAccelerator({ mod: true, shift: true, alt: true, key: "X" })).toBe(
			"CmdOrCtrl+Shift+Alt+X"
		);
		expect(chordAccelerator({ key: "F11" })).toBe("F11");
	});

	it("names the keys whose glyph is not Electron's word for them", () => {
		expect(chordAccelerator({ mod: true, key: "+" })).toBe("CmdOrCtrl+Plus");
		expect(chordAccelerator({ alt: true, key: "←" })).toBe("Alt+Left");
		expect(chordAccelerator({ alt: true, key: "→" })).toBe("Alt+Right");
	});

	it("passes through the keys the grammar takes as written", () => {
		for (const key of ["=", "-", ",", "[", "]", "0"]) {
			expect(chordAccelerator({ mod: true, key })).toBe(`CmdOrCtrl+${key}`);
		}
	});
});

describe.each(["darwin", "win32", "linux"] as const)("the menu on %s", (platform) => {
	it("registers the accelerator of each chord the panel lists", async () => {
		const s = await loadShortcutsOn(platform);
		const registered = menuAccelerators(platform);

		expect(registered).toEqual({
			back: chordAccelerator(s.GO_BACK_CHORD),
			forward: chordAccelerator(s.GO_FORWARD_CHORD),
			actualSize: chordAccelerator(s.RESET_ZOOM_CHORD),
			zoomIn: chordAccelerator(s.ZOOM_IN_CHORD),
			zoomInPlus: chordAccelerator({ ...s.ZOOM_IN_CHORD, key: "+" }),
			zoomOut: chordAccelerator(s.ZOOM_OUT_CHORD),
			closeWindow: chordAccelerator(s.CLOSE_WINDOW_CHORD),
			quit: chordAccelerator(s.QUIT_CHORD),
			preferences: chordAccelerator(s.SETTINGS_CHORD),
		});
	});

	it("lists every chord it registers in Settings > Keyboard shortcuts", async () => {
		const s = await loadShortcutsOn(platform);
		const listed = new Set(s.SHORTCUT_GROUPS.flatMap((group) => [...group.chords]));
		for (const chord of [
			s.GO_BACK_CHORD,
			s.GO_FORWARD_CHORD,
			s.RESET_ZOOM_CHORD,
			s.ZOOM_IN_CHORD,
			s.ZOOM_OUT_CHORD,
			s.CLOSE_WINDOW_CHORD,
			s.QUIT_CHORD,
			s.SETTINGS_CHORD,
			s.FULL_SCREEN_CHORD,
		]) {
			expect(listed.has(chord), chord.label).toBe(true);
		}
	});
});

describe("the back and forward accelerators", () => {
	it("are the bracket pair on macOS and Alt+Arrow elsewhere", () => {
		expect(menuAccelerators("darwin")).toMatchObject({
			back: "CmdOrCtrl+[",
			forward: "CmdOrCtrl+]",
		});
		for (const platform of ["win32", "linux"]) {
			expect(menuAccelerators(platform)).toMatchObject({
				back: "Alt+Left",
				forward: "Alt+Right",
			});
		}
	});
});

describe("full screen", () => {
	it("is F11 off macOS and Control-Command-F on it, the role's own defaults", async () => {
		const mac = await loadShortcutsOn("darwin");
		expect(mac.FULL_SCREEN_CHORD).toMatchObject({ mod: true, ctrl: true, key: "F" });
		const other = await loadShortcutsOn("linux");
		expect(other.FULL_SCREEN_CHORD).toEqual({ key: "F11", label: "Full screen" });
	});
});

describe("createMenu in main.ts", () => {
	const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");
	const start = main.indexOf("function createMenu()");
	const body = main.slice(start, main.indexOf("Menu.setApplicationMenu(menu)", start));
	const accelerators = [...body.matchAll(/accelerator:\s*([^\s,}]+)/g)].map((m) => m[1]);

	it("scans a menu that has accelerators at all", () => {
		// An empty slice would pass the literal check below.
		expect(start).toBeGreaterThan(0);
		expect(accelerators.length).toBeGreaterThanOrEqual(9);
	});

	it("takes every accelerator from the table, never a literal", () => {
		for (const accelerator of accelerators) {
			expect(accelerator).toMatch(/^accelerators\.\w+$/);
		}
	});

	it("uses each entry of the table", () => {
		for (const name of Object.keys(menuAccelerators("linux"))) {
			expect(body, name).toContain(`accelerators.${name}`);
		}
	});
});
