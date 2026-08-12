/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The default UI face is stated in four places, and they must agree.
 *
 * `index.css` assigns `--font-sans` and is what paints before any script runs.
 * The pre-paint block in `index.html` overrides that property for a *stored*
 * preference, and deliberately carries no entry for the default - selecting the
 * default means "leave the stylesheet alone". `DEFAULT_UI_FONT` is what the
 * appearance store re-asserts on mount when nothing is stored. The picker
 * captions one option "Default - ...".
 *
 * When `DEFAULT_UI_FONT` was `"inter"` all four disagreed: a fresh install
 * painted Space Grotesk from the stylesheet, then swapped to Inter the moment
 * React mounted, under a picker whose Space Grotesk option said "Default" and a
 * `docs/design-system.md` that named Space Grotesk as the UI face. Only the
 * cross-file check catches that - each file alone is self-consistent.
 *
 * Read from disk rather than imported: vitest stubs a CSS import to `""`, and a
 * guard that scans an empty string passes for weeks while proving nothing (see
 * the repo CLAUDE.md). Hence the non-empty assertions before every scan.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, MONO_FONTS, UI_FONTS, fontStack } from "./appearance";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const indexCss = read("../index.css");
const indexHtml = read("../../index.html");

describe("the default UI font", () => {
	it("scanned non-empty sources", () => {
		// Without this the two scans below are vacuous.
		expect(indexCss.length).toBeGreaterThan(0);
		expect(indexHtml.length).toBeGreaterThan(0);
	});

	it("is the stack index.css already assigns to --font-sans", () => {
		const declared = /--font-sans:\s*([^;]+);/.exec(indexCss)?.[1].trim();
		expect(declared).toBeDefined();
		expect(fontStack(DEFAULT_UI_FONT)).toBe(declared);
	});

	it("has no entry in the pre-paint override map", () => {
		// The map exists only to override the stylesheet. An entry for the
		// default would be dead weight; a *missing* entry for a non-default face
		// is the real bug, so assert the complement too.
		const map = /var fonts = \{([\s\S]*?)\};/.exec(indexHtml)?.[1];
		expect(map).toBeDefined();
		const overridden = [...(map ?? "").matchAll(/^\s*(\w[\w-]*):/gm)].map((m) => m[1]);
		expect(overridden.length).toBeGreaterThan(0);
		expect(overridden).not.toContain(DEFAULT_UI_FONT);
		expect([...overridden].sort()).toEqual(
			UI_FONTS.map((f) => f.value)
				.filter((v) => v !== DEFAULT_UI_FONT)
				.sort()
		);
	});

	it("is the option the picker captions Default", () => {
		const captioned = UI_FONTS.filter((f) => f.description.startsWith("Default"));
		expect(captioned.map((f) => f.value)).toEqual([DEFAULT_UI_FONT]);
	});
});

describe("the default code font", () => {
	// Same invariant, minus the pre-paint leg: `--font-mono` is never stamped
	// before React mounts, so only the caption and the constant can drift.
	it("is the option the picker captions Default", () => {
		const captioned = MONO_FONTS.filter((f) => f.description.startsWith("Default"));
		expect(captioned.map((f) => f.value)).toEqual([DEFAULT_MONO_FONT]);
	});
});
