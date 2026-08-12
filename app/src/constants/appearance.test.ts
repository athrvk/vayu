/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import {
	DEFAULT_MONO_FONT,
	DEFAULT_UI_FONT,
	DEFAULT_UI_SCALE,
	UI_SCALE_MAX,
	UI_SCALE_MIN,
	clampScale,
	customFontStack,
	customMonoStack,
	customSansStack,
	fontStack,
	formatScale,
	monoFontStack,
	nudgeScale,
	parseScale,
} from "./appearance";

describe("customFontStack", () => {
	it("returns the fallback for an empty family", () => {
		expect(customFontStack("", "monospace")).toBe("monospace");
		expect(customFontStack("   ", "monospace")).toBe("monospace");
	});

	it("quotes a bare family and appends the fallback", () => {
		expect(customFontStack("Cascadia Code", "monospace")).toBe('"Cascadia Code", monospace');
	});

	it("strips stray quotes from a bare family", () => {
		expect(customFontStack('"Comic Mono"', "monospace")).toBe('"Comic Mono", monospace');
	});

	it("passes a comma-containing stack through verbatim", () => {
		expect(customFontStack("Menlo, monospace", "x")).toBe("Menlo, monospace");
	});

	it("mono/sans wrappers apply their respective fallbacks", () => {
		expect(customMonoStack("Iosevka")).toContain('"Iosevka",');
		expect(customMonoStack("Iosevka")).toContain("monospace");
		expect(customSansStack("Georgia")).toBe(
			'"Georgia", "Space Grotesk", system-ui, sans-serif'
		);
	});

	// A custom family that fails to load must land on the same face a user who
	// never opened the picker sees, not on a second, parallel default.
	it("falls back to the default preset's own stack", () => {
		expect(customSansStack("Georgia").endsWith(fontStack(DEFAULT_UI_FONT))).toBe(true);
		expect(customMonoStack("Iosevka").endsWith(monoFontStack(DEFAULT_MONO_FONT))).toBe(true);
	});
});

describe("clampScale", () => {
	it("holds at both ends of the range", () => {
		expect(clampScale(0.5)).toBe(UI_SCALE_MIN);
		expect(clampScale(5)).toBe(UI_SCALE_MAX);
	});

	it("snaps an off-grid factor onto the step", () => {
		expect(clampScale(1.23)).toBe(1.2);
		expect(clampScale(1.27)).toBe(1.3);
	});

	it("rounds away the drift that repeated nudging accumulates", () => {
		// 0.1 * 3 is 0.30000000000000004 in binary floating point, and the drift
		// would otherwise reach both the stored string and the zoom factor.
		expect(clampScale(0.8 + 0.1 + 0.1 + 0.1)).toBe(1.1);
		expect(String(clampScale(1.2000000000000002))).toBe("1.2");
	});

	it("falls back to the default for a non-finite factor", () => {
		expect(clampScale(Number.NaN)).toBe(DEFAULT_UI_SCALE);
		expect(clampScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_UI_SCALE);
	});
});

describe("parseScale", () => {
	it("migrates each legacy preset name to the factor it applied", () => {
		expect(parseScale("compact")).toBe(0.9);
		expect(parseScale("default")).toBe(1);
		expect(parseScale("comfortable")).toBe(1.1);
	});

	it("reads a stored numeric factor", () => {
		expect(parseScale("1.5")).toBe(1.5);
		expect(parseScale("2")).toBe(2);
	});

	it("clamps a stored factor that is out of range or off-grid", () => {
		expect(parseScale("9")).toBe(UI_SCALE_MAX);
		expect(parseScale("0.1")).toBe(UI_SCALE_MIN);
		expect(parseScale("1.44")).toBe(1.4);
	});

	it("falls back to the default for garbage and for nothing stored", () => {
		expect(parseScale(null)).toBe(DEFAULT_UI_SCALE);
		expect(parseScale("")).toBe(DEFAULT_UI_SCALE);
		expect(parseScale("banana")).toBe(DEFAULT_UI_SCALE);
		// A Map, not an object literal - a stored prototype key must not resolve.
		expect(parseScale("constructor")).toBe(DEFAULT_UI_SCALE);
		expect(parseScale("toString")).toBe(DEFAULT_UI_SCALE);
	});
});

describe("nudgeScale", () => {
	it("moves one step per unit in either direction", () => {
		expect(nudgeScale(1, 1)).toBe(1.1);
		expect(nudgeScale(1, -1)).toBe(0.9);
		expect(nudgeScale(1, 3)).toBe(1.3);
	});

	it("holds at the ends rather than running past them", () => {
		expect(nudgeScale(UI_SCALE_MAX, 1)).toBe(UI_SCALE_MAX);
		expect(nudgeScale(UI_SCALE_MIN, -1)).toBe(UI_SCALE_MIN);
	});
});

describe("formatScale", () => {
	it("reads as the percentage every surface shows", () => {
		expect(formatScale(1)).toBe("100%");
		expect(formatScale(0.8)).toBe("80%");
		expect(formatScale(1.25)).toBe("125%");
	});
});
