/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One formatter for a timing phase, because there were three.
 *
 * DNS, connect, TLS, first byte and download were rendered by the dashboard at
 * `toFixed(2)`, by the history breakdown at `toFixed(1)`, and by the
 * request-builder timing tab with significant digits. Same five numbers, three
 * answers, depending which screen you were on. The third was already right; it
 * moved somewhere the other two could reach it.
 */

import { describe, it, expect } from "vitest";
import { formatPhaseMs, formatResponseTime, formatPhaseDuration, formatDuration } from "./utils";

describe("formatPhaseMs", () => {
	it("keeps two decimals below 10ms, where a phase often lives", () => {
		// A cached DNS lookup or a warm local connect. `toFixed(1)` rounds these
		// to "0.0" and loses the only signal there is.
		expect(formatPhaseMs(0.04)).toBe("0.04");
		expect(formatPhaseMs(3.216)).toBe("3.22");
	});

	it("drops to one decimal in the tens", () => {
		expect(formatPhaseMs(10)).toBe("10.0");
		expect(formatPhaseMs(47.83)).toBe("47.8");
	});

	it("drops decimals entirely past 100ms, where they are noise", () => {
		expect(formatPhaseMs(100)).toBe("100");
		expect(formatPhaseMs(312.7)).toBe("313");
	});

	it("is a different job from formatResponseTime, which does switch unit", () => {
		expect(formatResponseTime(5_000)).toBe("5.00 s");
		expect(formatPhaseMs(5_000)).toBe("5000");
	});
});

/**
 * The invariant is "one unit per row", not "always milliseconds".
 *
 * `formatPhaseMs` pinned ms so a row of phases stays comparable, and its comment
 * asserted a phase "is always sub-second in practice". That is false: a slow
 * endpoint produced `28696 ms` for first-byte, which nobody reads as 28.7
 * seconds. The unit is still fixed across the row - that part was right - but it
 * is now chosen from the row rather than assumed.
 */
describe("formatPhaseDuration", () => {
	it("keeps milliseconds, with the phase ladder's precision", () => {
		expect(formatPhaseDuration(0.96)).toEqual({ value: "0.96", unit: "ms" });
		expect(formatPhaseDuration(3.79)).toEqual({ value: "3.79", unit: "ms" });
		expect(formatPhaseDuration(262)).toEqual({ value: "262", unit: "ms" });
		expect(formatPhaseDuration(530)).toEqual({ value: "530", unit: "ms" });
	});

	it("switches to seconds only for the phase that actually runs long", () => {
		expect(formatPhaseDuration(28_696)).toEqual({ value: "28.70", unit: "s" });
	});

	it("does not drag the small phases along with it", () => {
		// An earlier version fixed one unit per row, which rendered a 262ms
		// connect as "0.26 s" and a 0.96ms download as "0.00 s". Milliseconds are
		// perfectly readable; only the long phase needs converting.
		const row = [3.79, 262, 530, 28_696, 0.96].map(formatPhaseDuration);
		expect(row.map((r) => r.unit)).toEqual(["ms", "ms", "ms", "s", "ms"]);
		expect(row.map((r) => r.value)).toEqual(["3.79", "262", "530", "28.70", "0.96"]);
	});

	it("agrees with formatDuration on where the unit turns over", () => {
		for (const ms of [999, 1_000, 1_001, 60_000]) {
			expect(formatPhaseDuration(ms).unit).toBe(formatDuration(ms).unit);
		}
	});
});

describe("formatDuration", () => {
	it("splits value from unit, so the unit can be styled apart", () => {
		expect(formatDuration(340)).toEqual({ value: "340", unit: "ms" });
		expect(formatDuration(29_494)).toEqual({ value: "29.49", unit: "s" });
		expect(formatDuration(0.22)).toEqual({ value: "0.22", unit: "ms" });
	});

	it("is what formatResponseTime is built from, so they cannot drift", () => {
		for (const ms of [0.4, 340, 999.6, 1_000, 2_400, 29_494, 65_432, 200_000]) {
			const { value, unit } = formatDuration(ms);
			expect(formatResponseTime(ms)).toBe(`${value} ${unit}`);
		}
	});

	it("keeps a sub-millisecond queue wait readable next to a 29s total", () => {
		expect(formatDuration(0.22).unit).toBe("ms");
		expect(formatDuration(29_494).unit).toBe("s");
	});
});
