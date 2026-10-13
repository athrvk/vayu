/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `formatClock` is the header's MM:SS readout; `formatDuration` is the prose
 * form. They disagree on purpose, so each is pinned against the same input.
 */

import { describe, expect, it } from "vitest";
import { formatClock, formatDuration } from "./format";

describe("formatClock", () => {
	it("pads minutes and seconds to two digits", () => {
		expect(formatClock(0)).toBe("00:00");
		expect(formatClock(2000)).toBe("00:02");
		expect(formatClock(65_000)).toBe("01:05");
	});

	it("truncates sub-second movement so a ticking counter never skips ahead", () => {
		expect(formatClock(1999)).toBe("00:01");
		expect(formatClock(2100)).toBe("00:02");
	});

	it("lets minutes pass 59 rather than rolling into hours", () => {
		expect(formatClock(75 * 60_000)).toBe("75:00");
	});

	it("reads a negative duration as zero", () => {
		expect(formatClock(-5000)).toBe("00:00");
	});
});

describe("formatDuration", () => {
	it("stays the prose form, distinct from the clock", () => {
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatClock(65_000)).not.toBe(formatDuration(65_000));
	});
});
