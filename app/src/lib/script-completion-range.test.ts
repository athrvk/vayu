/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { completionReplaceStartColumn } from "./script-completion-range";

// linePrefix is the text before the cursor; cursorColumn is 1-based (length + 1).
const at = (linePrefix: string) => completionReplaceStartColumn(linePrefix, linePrefix.length + 1);

describe("completionReplaceStartColumn", () => {
	it("replaces the whole `pm.` so a full-path insert does not duplicate it", () => {
		// "pm." -> cursor col 4 -> start col 1 (replace from the 'p')
		expect(at("pm.")).toBe(1);
	});

	it("replaces a partial member after the dot", () => {
		expect(at("pm.re")).toBe(1);
		expect(at("pm.response.")).toBe(1);
		expect(at("pm.response.co")).toBe(1);
	});

	it("replaces only the chain, not preceding code", () => {
		// "const x = pm." -> 'p' is at column 11
		expect(at("const x = pm.")).toBe(11);
		expect(at("\treturn console.")).toBe(9);
	});

	it("does NOT cross a non-identifier boundary like `)` so member items keep the dot", () => {
		// After "pm.expect(x)." there is no chain ending at the cursor (')' breaks it),
		// so we return the cursor column -> zero-width insert after the dot.
		expect(at("pm.expect(x).")).toBe("pm.expect(x).".length + 1);
	});

	it("replaces a partial chain member typed after a call", () => {
		// "pm.expect(x).to" -> 'to' starts at column 14
		expect(at("pm.expect(x).to")).toBe(14);
	});

	it("returns the cursor column on empty / whitespace prefixes", () => {
		expect(at("")).toBe(1);
		expect(at("   ")).toBe(4);
	});

	it("handles a bare identifier with no dot (quick suggestions)", () => {
		expect(at("pm")).toBe(1);
	});
});
