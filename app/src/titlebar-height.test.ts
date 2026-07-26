/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The title bar's height and colours live in two files that cannot import each
 * other.
 *
 * `electron/constants.ts` sizes the real window frame - the Windows caption
 * overlay and the macOS traffic-light inset - and runs in the main process.
 * `src/index.css` sizes everything the renderer draws, and the toast stack
 * subtracts the same value to avoid landing on the bar. The two tsconfigs share
 * no module graph (`tsconfig.json` includes `src`, `tsconfig.node.json`
 * includes `electron`), so a shared constant is not available and nothing but a
 * test can hold them together.
 *
 * The height is per platform on purpose: 32px is the Windows standard *and* its
 * floor, because `titleBarOverlay.height` is what the OS draws its 46x32 caption
 * buttons at, while macOS runs 28px as its own standard. So this asserts the
 * mapping, not a single number - the previous version pinned one 38px value and
 * would have passed a per-platform change that silently disagreed.
 *
 * The colours are here for the same reason. Electron paints the overlay and the
 * pre-paint window background before any stylesheet exists, so it has to name
 * them; they had drifted to `#f2f0eb`, a warm cream from a palette two
 * revisions old, against a `--panel` of `#fafafa`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Read from disk rather than importing: vitest stubs CSS to "", and electron/
// is outside this project's module graph.
const css = readFileSync(join(here, "index.css"), "utf8");
const constants = readFileSync(join(here, "..", "electron", "constants.ts"), "utf8");
// The centring formula itself lives where the window is created.
const mainTs = readFileSync(join(here, "..", "electron", "main.ts"), "utf8");

/** The `--titlebar-height` declared under a given selector, in px. */
function cssHeight(selector: string | null): number | null {
	const block = selector
		? new RegExp(`${selector.replace(/[[\]"=]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)
		: /:root\s*\{([\s\S]*?)\n\t\}/.exec(css);
	if (!block) return null;
	const m = /--titlebar-height:\s*(\d+)px/.exec(block[1]);
	return m ? Number(m[1]) : null;
}

/** A numeric field of TITLEBAR_HEIGHT_BY_PLATFORM. */
function electronHeight(platform: string): number | null {
	const map = /TITLEBAR_HEIGHT_BY_PLATFORM\s*=\s*\{([^}]*)\}/.exec(constants);
	if (!map) return null;
	const m = new RegExp(`${platform}:\\s*(\\d+)`).exec(map[1]);
	return m ? Number(m[1]) : null;
}

describe("title bar height", () => {
	it("reads both files", () => {
		// A guard that scanned an empty string passed for weeks elsewhere here.
		expect(css.length).toBeGreaterThan(1000);
		expect(constants).toContain("TITLEBAR_HEIGHT_BY_PLATFORM");
		expect(mainTs.length).toBeGreaterThan(1000);
	});

	it("agrees between index.css and electron/constants.ts, per platform", () => {
		// The default in :root covers Windows and Linux; mac overrides it.
		expect(cssHeight(null)).toBe(electronHeight("win32"));
		expect(electronHeight("linux")).toBe(electronHeight("win32"));
		expect(cssHeight('[data-platform="mac"]')).toBe(electronHeight("darwin"));
	});

	it("never goes under the Windows caption buttons' own height", () => {
		// titleBarOverlay.height is what the OS draws them at, and they are 46x32.
		// Below 32 they are squeezed, and the platform requires them fully visible.
		expect(electronHeight("win32")).toBeGreaterThanOrEqual(32);
		expect(electronHeight("linux")).toBeGreaterThanOrEqual(32);
	});

	it("leaves room for the macOS traffic lights", () => {
		// The frame is 14px, centred via trafficLightPosition.
		expect(electronHeight("darwin")).toBeGreaterThanOrEqual(24);
	});

	it("keeps the Electron colours on the renderer's tokens", () => {
		const hex = (name: string) =>
			new RegExp(`${name}\\s*=\\s*"(#[0-9a-f]{6})"`).exec(constants)?.[1];
		// --panel, both themes: the overlay has to vanish into the bar it sits in.
		expect(hex("TITLEBAR_BG_LIGHT")).toBe("#fafafa");
		expect(hex("TITLEBAR_BG_DARK")).toBe("#111113");
		// --foreground, for the caption glyphs.
		expect(hex("TITLEBAR_FG_LIGHT")).toBe("#18181b");
		expect(hex("TITLEBAR_FG_DARK")).toBe("#f4f4f5");
		// --background, for the frame before the first paint.
		expect(hex("WINDOW_BG_LIGHT")).toBe("#f4f4f5");
		expect(hex("WINDOW_BG_DARK")).toBe("#09090b");
		// The cream that was there before, from a palette two revisions old.
		// Matched as an assigned value, not as any mention: the constant's own
		// comment names it to explain the drift, and a guard that trips on its
		// own documentation would just get the documentation deleted.
		expect(constants).not.toMatch(/=\s*"#f2f0eb"/);
	});

	it("centres the macOS traffic lights on the frame Electron positions", () => {
		// The buttons are 12px. The centring formula used 16, which put them 2px
		// high at every bar height - unnoticeable at 38px, visible once the bar
		// went to 28. Asserting the constant is what stops it drifting back.
		const num = (name: string) =>
			Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(constants)?.[1]);
		// 14: Electron positions the button *frame*, not the 12pt circle, and
		// centring on the circle leaves the cluster a pixel off.
		expect(num("TRAFFIC_LIGHT_FRAME_HEIGHT")).toBe(14);
		expect(mainTs).toContain("TITLEBAR_HEIGHT - TRAFFIC_LIGHT_FRAME_HEIGHT");
		// x clears the window's rounded top corner (~10-12px). At 12 the close
		// button sat inside the curve, which no amount of vertical centring fixes.
		expect(num("TRAFFIC_LIGHT_X")).toBeGreaterThanOrEqual(20);
	});

	it("reserves the same inset in both files", () => {
		// Electron positions the buttons; the renderer reserves room so the first
		// tab does not land on them. Two files, no shared module.
		const inset = Number(/TRAFFIC_LIGHT_INSET\s*=\s*(\d+)/.exec(constants)?.[1]);
		const css_ = Number(/--traffic-light-inset:\s*(\d+)px/.exec(css)?.[1]);
		expect(inset).toBe(css_);
		// It has to clear the group: a 20px lead plus three buttons on a 20px pitch
		// ends at 84px, and the gutter after it should be visible.
		expect(inset).toBeGreaterThanOrEqual(84);
	});
});
