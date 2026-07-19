/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { customFontStack, customMonoStack, customSansStack } from "./appearance";

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
		expect(customSansStack("Georgia")).toBe('"Georgia", Inter, system-ui, sans-serif');
	});
});
