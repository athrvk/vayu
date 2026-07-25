/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load test configuration defaults and input limits.
 *
 * Limits mirror what the engine accepts on /run - keep them in sync with the
 * engine's validation when it changes.
 */

export const LOAD_TEST_DEFAULTS = {
	MODE: "constant_rps",
	DURATION_S: 60,
	RPS: 100,
	CONCURRENCY: 10,
	ITERATIONS: 1000,
	RAMP_DURATION_S: 30,
	/** Ramp-Up starts here and climbs to CONCURRENCY. Matches the engine default. */
	START_CONCURRENCY: 1,
	/** % of successful responses persisted for inspection. */
	SAMPLE_RATE_PCT: 10,
	/** Responses slower than this are flagged and saved. */
	SLOW_THRESHOLD_MS: 1000,
	SAVE_TIMING_BREAKDOWN: true,
} as const;

export const LOAD_TEST_LIMITS = {
	DURATION_S: { MIN: 1, MAX: 3600 },
	RPS: { MIN: 1, MAX: 50_000 },
	MAX_IN_FLIGHT: { MIN: 1, MAX: 1_000_000 },
	CONCURRENCY: { MIN: 1, MAX: 1000 },
	ITERATIONS: { MIN: 1, MAX: 1_000_000 },
	RAMP_DURATION_S: { MIN: 1, MAX: 3600 },
	START_CONCURRENCY: { MIN: 1, MAX: 1000 },
	/**
	 * MIN is 1, not 0. The value is sent as `success_sample_rate`, which the
	 * engine uses as a sampling *period* - `counter % success_sample_rate` - so
	 * a 0 was an integer division by zero that killed the whole daemon mid-run,
	 * reachable by dragging this slider to its left stop. The engine now rejects
	 * it with a 400 (and clamps defensively); this keeps the control from
	 * offering a value no run can use. "Keep no success traces" is still
	 * expressible - that is what the Save timing breakdown toggle does.
	 */
	SAMPLE_RATE_PCT: { MIN: 1, MAX: 100 },
	SLOW_THRESHOLD_MS: { MIN: 0, MAX: 60_000 },
} as const;
