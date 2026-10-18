/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { formatNumber } from "@/lib/format-number";
import { fmtRate, orDash } from "./format";

describe("orDash", () => {
	it("draws a dash for a missing value, never the formatter's zero", () => {
		expect(orDash(undefined, formatNumber)).toBe("-");
		expect(fmtRate(undefined)).toBe("-");
	});

	it("keeps a measured zero a zero", () => {
		expect(orDash(0, formatNumber)).toBe("0");
		expect(fmtRate(0)).toBe("0");
	});

	it("hands a present value to the formatter", () => {
		expect(orDash(7, (n) => `<${n}>`)).toBe("<7>");
	});
});
