/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Response time and size formatting.
 *
 * `formatResponseTime` exists because `time.toFixed(4)` was written twice, in
 * two response viewers. Fixing one left the other rendering `340.1235 ms` - the
 * duplication was the defect, so the test lives with the shared function rather
 * than with either caller.
 */

import { describe, it, expect } from "vitest";
import { formatResponseTime, formatSize } from "./utils";

describe("formatResponseTime", () => {
	it("rounds to whole milliseconds in the common range", () => {
		expect(formatResponseTime(340.1235)).toBe("340 ms");
		expect(formatResponseTime(1.4)).toBe("1 ms");
		expect(formatResponseTime(999.6)).toBe("1000 ms");
	});

	it("keeps decimals below a millisecond, where they carry information", () => {
		// A local mock or a cache hit. "0 ms" would lose the only signal there is.
		expect(formatResponseTime(0.4321)).toBe("0.43 ms");
		expect(formatResponseTime(0)).toBe("0.00 ms");
	});

	it("switches to seconds past a thousand", () => {
		expect(formatResponseTime(1000)).toBe("1.00 s");
		expect(formatResponseTime(2400)).toBe("2.40 s");
		expect(formatResponseTime(65_432)).toBe("65.43 s");
	});

	it("never emits four decimal places", () => {
		for (const ms of [0.5, 1, 12.3456, 340.1235, 999, 1000, 98_765.4321]) {
			expect(formatResponseTime(ms), String(ms)).not.toMatch(/\.\d{3,}/);
		}
	});
});

describe("formatSize", () => {
	it("steps through B, KB and MB", () => {
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(2048)).toBe("2.0 KB");
		expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
	});

	it("switches unit exactly at the boundary", () => {
		expect(formatSize(1023)).toBe("1023 B");
		expect(formatSize(1024)).toBe("1.0 KB");
		expect(formatSize(1024 * 1024 - 1)).toContain("KB");
		expect(formatSize(1024 * 1024)).toBe("1.0 MB");
	});
});
