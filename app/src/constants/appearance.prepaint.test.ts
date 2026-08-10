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
 * index.html's pre-paint script applies the saved interface scale before React
 * mounts, so the first frame is not drawn at 100% and then resized. It is a
 * deliberate duplicate of `clampScale` / `parseScale` - it cannot import them,
 * because it runs before any module does - and duplicates drift.
 *
 * This runs the real script rather than scanning it for a substring: a scan
 * that stops matching after a rewrite goes green for the wrong reason, and a
 * scan cannot tell whether the legacy migration still produces 1.1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_SCALE_MAX, UI_SCALE_MIN } from "./appearance";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The body of the inline pre-paint IIFE at the top of index.html. */
function prePaintSource(): string {
	const html = readFileSync(join(appRoot, "index.html"), "utf8");
	const match = /<script>([\s\S]*?)<\/script>/.exec(html);
	if (!match) throw new Error("index.html has no inline pre-paint script");
	return match[1];
}

/** Run the pre-paint script against the current localStorage + document. */
function runPrePaint(): void {
	new Function(prePaintSource())();
}

beforeEach(() => {
	localStorage.clear();
	document.documentElement.style.zoom = "";
	// The script's zoom branch sits behind the theme branch, which reads
	// matchMedia - and the whole body is inside a try/catch, so an unstubbed
	// throw there would silently skip the zoom rather than fail loudly.
	vi.stubGlobal("electronAPI", undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.style.zoom = "";
});

describe("index.html pre-paint scale", () => {
	it("reads a script that is actually there", () => {
		// Guards the extraction itself: a regex that silently matched "" would
		// make every case below pass while testing nothing.
		expect(prePaintSource()).toContain("vayu-ui-scale");
		expect(prePaintSource().length).toBeGreaterThan(500);
	});

	it("applies a stored numeric factor before React mounts", () => {
		localStorage.setItem("vayu-ui-scale", "1.5");
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe("1.5");
	});

	it.each([
		["compact", "0.9"],
		["default", "1"],
		["comfortable", "1.1"],
	])("migrates the legacy %s preset to %s", (stored, expected) => {
		localStorage.setItem("vayu-ui-scale", stored);
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe(expected);
	});

	it("clamps a stored factor to the same range the store uses", () => {
		localStorage.setItem("vayu-ui-scale", "9");
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe(String(UI_SCALE_MAX));

		document.documentElement.style.zoom = "";
		localStorage.setItem("vayu-ui-scale", "0.1");
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe(String(UI_SCALE_MIN));
	});

	it("leaves the zoom alone when nothing is stored or the value is garbage", () => {
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe("");

		localStorage.setItem("vayu-ui-scale", "banana");
		runPrePaint();
		expect(document.documentElement.style.zoom).toBe("");
	});

	it("prefers Electron's real page zoom when the bridge is there", () => {
		const setZoomFactor = vi.fn();
		vi.stubGlobal("electronAPI", { setZoomFactor });
		localStorage.setItem("vayu-ui-scale", "1.2");
		runPrePaint();

		expect(setZoomFactor).toHaveBeenCalledWith(1.2);
		expect(document.documentElement.style.zoom).toBe("");
	});
});
