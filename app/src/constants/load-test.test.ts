/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Two units and two audiences meet in this file, and both were previously
 * wrong in ways nothing failed on:
 *
 *   - The sample-rate control is a percentage; the engine's field is a period.
 *     They were the same number, so the slider meant its own inverse.
 *   - The dialog's ceilings are the app's policy, sitting inside the engine's
 *     crash guards. A user-set ceiling that escaped those guards would turn a
 *     settings screen into a way to make the daemon reject - or before the
 *     engine's own validation landed, crash on - a run.
 */

import { describe, it, expect } from "vitest";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_CEILING_BOUNDS,
	LOAD_TEST_DEFAULTS,
	LOAD_TEST_LIMITS,
	clampCeiling,
	clampToRange,
	resolveLoadTestLimits,
	successSamplePeriod,
	type LoadTestCeilingKey,
} from "./load-test";

const CEILING_KEYS = Object.keys(LOAD_TEST_CEILING_BOUNDS) as LoadTestCeilingKey[];

describe("successSamplePeriod", () => {
	it("maps the ends of the slider to the ends they are labelled with", () => {
		// 100% keeps everything, which is a period of 1. This is the pair that
		// was inverted: 100 went out as 100 and kept one response in a hundred.
		expect(successSamplePeriod(100)).toBe(1);
		expect(successSamplePeriod(1)).toBe(100);
	});

	it("leaves the default unchanged, the one value that was accidentally right", () => {
		expect(successSamplePeriod(LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT)).toBe(
			LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT
		);
	});

	it("rounds a percentage that does not divide 100 to the nearest whole period", () => {
		expect(successSamplePeriod(50)).toBe(2);
		expect(successSamplePeriod(33)).toBe(3);
		expect(successSamplePeriod(40)).toBe(3); // 100/40 = 2.5
	});

	it("never returns 0, whatever it is handed", () => {
		// 0 on the wire is `counter % 0` engine-side - a SIGFPE that takes the
		// daemon down mid-run, along with every other run and SSE stream.
		for (const input of [0, -1, -100, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(successSamplePeriod(input)).toBeGreaterThanOrEqual(1);
		}
	});

	it("is monotonic: a higher percentage never keeps less", () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let pct = 1; pct <= 100; pct++) {
			const period = successSamplePeriod(pct);
			expect(period).toBeLessThanOrEqual(previous);
			previous = period;
		}
	});
});

describe("ceiling clamping", () => {
	it.each(CEILING_KEYS)("holds %s inside the engine's guard", (key) => {
		const { MIN, MAX } = LOAD_TEST_CEILING_BOUNDS[key];
		expect(clampCeiling(key, MAX * 10)).toBe(MAX);
		expect(clampCeiling(key, MIN - 1)).toBe(MIN);
		expect(clampCeiling(key, Number.NaN)).toBe(MIN);
	});

	it("keeps a value already inside the range", () => {
		expect(clampCeiling("concurrency", 2500)).toBe(2500);
	});

	it("rounds, since a ceiling on a whole-number field cannot be fractional", () => {
		expect(clampCeiling("concurrency", 12.6)).toBe(13);
	});

	it.each(CEILING_KEYS)("ships %s at a default inside its own bounds", (key) => {
		const { MIN, MAX } = LOAD_TEST_CEILING_BOUNDS[key];
		expect(DEFAULT_LOAD_TEST_CEILINGS[key]).toBeGreaterThanOrEqual(MIN);
		expect(DEFAULT_LOAD_TEST_CEILINGS[key]).toBeLessThanOrEqual(MAX);
	});
});

describe("clampToRange", () => {
	it("repairs a NaN to the floor rather than propagating it", () => {
		// An emptied number input parses to NaN, and a NaN `max` on a field
		// disables the browser's own range check silently.
		expect(clampToRange(Number.NaN, { MIN: 5, MAX: 10 })).toBe(5);
	});
});

describe("resolveLoadTestLimits", () => {
	it("returns the shipped ranges for the shipped ceilings", () => {
		expect(resolveLoadTestLimits(DEFAULT_LOAD_TEST_CEILINGS)).toEqual(LOAD_TEST_LIMITS);
	});

	it("applies a connection ceiling to the ramp's start as well as its target", () => {
		const limits = resolveLoadTestLimits({ ...DEFAULT_LOAD_TEST_CEILINGS, concurrency: 4000 });
		expect(limits.CONCURRENCY.MAX).toBe(4000);
		expect(limits.START_CONCURRENCY.MAX).toBe(4000);
	});

	it("applies a duration ceiling to the ramp duration as well as the run", () => {
		const limits = resolveLoadTestLimits({
			...DEFAULT_LOAD_TEST_CEILINGS,
			durationSeconds: 7200,
		});
		expect(limits.DURATION_S.MAX).toBe(7200);
		expect(limits.RAMP_DURATION_S.MAX).toBe(7200);
	});

	it("clamps ceilings it is handed, so a stale stored value cannot widen a range", () => {
		const limits = resolveLoadTestLimits({
			...DEFAULT_LOAD_TEST_CEILINGS,
			concurrency: 10_000_000,
		});
		expect(limits.CONCURRENCY.MAX).toBe(LOAD_TEST_CEILING_BOUNDS.concurrency.MAX);
	});

	it("leaves the floors alone - those are not the user's to move", () => {
		const limits = resolveLoadTestLimits({
			rps: 1,
			concurrency: 1,
			durationSeconds: 1,
			iterations: 1,
		});
		for (const key of ["RPS", "CONCURRENCY", "DURATION_S", "ITERATIONS"] as const) {
			expect(limits[key].MIN).toBe(1);
		}
		// And the ranges the user cannot move stay put.
		expect(limits.SAMPLE_RATE_PCT).toEqual(LOAD_TEST_LIMITS.SAMPLE_RATE_PCT);
		expect(limits.MAX_IN_FLIGHT).toEqual(LOAD_TEST_LIMITS.MAX_IN_FLIGHT);
	});

	it("never lets the sample-rate floor return to the divisor-of-zero value", () => {
		expect(LOAD_TEST_LIMITS.SAMPLE_RATE_PCT.MIN).toBeGreaterThanOrEqual(1);
	});
});
