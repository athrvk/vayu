/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Load test configuration defaults and input limits.
 *
 * Two different things live here and they are easy to confuse:
 *
 *   - **`LOAD_TEST_LIMITS`** - the range each control in the load dialog
 *     offers. The ceilings are *this app's* policy, not the engine's, and four
 *     of them are user-adjustable (Settings -> Load testing). They sit well
 *     inside what the engine accepts, which is deliberate: the engine's own
 *     bounds are crash guards, so hitting one should be impossible from the UI
 *     rather than merely unlikely.
 *   - **`LOAD_TEST_CEILING_BOUNDS`** - how far the user may move those
 *     ceilings. The upper end of each is the engine's guard, so no Settings
 *     value can produce a request the engine rejects.
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

export interface LimitRange {
	MIN: number;
	MAX: number;
}

export type LoadTestLimitKey =
	| "DURATION_S"
	| "RPS"
	| "MAX_IN_FLIGHT"
	| "CONCURRENCY"
	| "ITERATIONS"
	| "RAMP_DURATION_S"
	| "START_CONCURRENCY"
	| "SAMPLE_RATE_PCT"
	| "SLOW_THRESHOLD_MS";

export type LoadTestLimits = Record<LoadTestLimitKey, LimitRange>;

/**
 * The dialog's ranges with no user overrides applied. Read through
 * `resolveLoadTestLimits` rather than directly, unless you specifically want
 * the shipped defaults.
 */
export const LOAD_TEST_LIMITS: LoadTestLimits = {
	DURATION_S: { MIN: 1, MAX: 3600 },
	RPS: { MIN: 1, MAX: 50_000 },
	MAX_IN_FLIGHT: { MIN: 1, MAX: 1_000_000 },
	CONCURRENCY: { MIN: 1, MAX: 1000 },
	ITERATIONS: { MIN: 1, MAX: 1_000_000 },
	RAMP_DURATION_S: { MIN: 1, MAX: 3600 },
	START_CONCURRENCY: { MIN: 1, MAX: 1000 },
	/**
	 * MIN is 1, not 0. The value is a *percentage of successful responses to
	 * keep*, converted to the engine's sampling period by
	 * `successSamplePeriod`. 0% has no period that expresses it (the period
	 * would be infinite, and a literal 0 on the wire is a division by zero
	 * engine-side, which the engine now rejects with a 400), so "keep no
	 * success traces" is the Save timing breakdown toggle instead - that gates
	 * storage entirely.
	 */
	SAMPLE_RATE_PCT: { MIN: 1, MAX: 100 },
	SLOW_THRESHOLD_MS: { MIN: 0, MAX: 60_000 },
};

/**
 * Convert the dialog's percentage into the engine's `success_sample_rate`.
 *
 * The engine treats that field as a sampling **period** - it keeps a trace when
 * `counter % success_sample_rate == 0`, i.e. one in every N - while the slider
 * has always been labelled, and stored, as a percentage. Nothing converted
 * between the two, so the two ends of the slider meant the opposite of what
 * they said: "100% - everything" sent a period of 100 and kept 1%, and the
 * left stop sent a period of 1 and kept *every* response. Only the default of
 * 10 was accidentally right, 1-in-10 being 10%, which is why it went unnoticed.
 *
 * Percentages that do not divide 100 land on the nearest whole period (33% ->
 * 1 in 3), because a period is by definition an integer.
 */
export function successSamplePeriod(percent: number): number {
	const { MIN, MAX } = LOAD_TEST_LIMITS.SAMPLE_RATE_PCT;
	const usable = Number.isFinite(percent) ? percent : LOAD_TEST_DEFAULTS.SAMPLE_RATE_PCT;
	const clamped = Math.min(Math.max(Math.round(usable), MIN), MAX);
	return Math.max(1, Math.round(100 / clamped));
}

/**
 * The four dialog ceilings a user can move, and the range each may move
 * within. `MAX` is the engine's own guard in every case, so a user who raises
 * a ceiling to its top still cannot compose a run the engine will reject:
 *
 * - `concurrency` - the engine caps a run at 10x `event_loop::MAX_CONCURRENT`,
 *   because that number becomes an *eager* per-worker curl-handle
 *   pre-allocation. It is also the ceiling on the `eventLoopMaxConcurrent`
 *   engine setting, which is the per-worker value a run actually gets.
 * - `durationSeconds` - a day, matching the engine's per-transfer timeout
 *   guard. A run longer than that wants a scheduler, not a dialog.
 * - `rps` / `iterations` - no engine guard applies; these are throughput
 *   figures, and the bound is the point past which a single desktop engine is
 *   not the right tool.
 */
export const LOAD_TEST_CEILING_BOUNDS = {
	rps: { MIN: 1, MAX: 1_000_000 },
	concurrency: { MIN: 1, MAX: 10_000 },
	durationSeconds: { MIN: 1, MAX: 86_400 },
	iterations: { MIN: 1, MAX: 100_000_000 },
} as const satisfies Record<string, LimitRange>;

export type LoadTestCeilingKey = keyof typeof LOAD_TEST_CEILING_BOUNDS;

export type LoadTestCeilings = Record<LoadTestCeilingKey, number>;

/** The shipped ceilings, identical to `LOAD_TEST_LIMITS` above. */
export const DEFAULT_LOAD_TEST_CEILINGS: LoadTestCeilings = {
	rps: LOAD_TEST_LIMITS.RPS.MAX,
	concurrency: LOAD_TEST_LIMITS.CONCURRENCY.MAX,
	durationSeconds: LOAD_TEST_LIMITS.DURATION_S.MAX,
	iterations: LOAD_TEST_LIMITS.ITERATIONS.MAX,
};

/** Hold a value inside a range. Also repairs a NaN from an emptied input. */
export function clampToRange(value: number, range: LimitRange): number {
	if (!Number.isFinite(value)) return range.MIN;
	return Math.min(Math.max(value, range.MIN), range.MAX);
}

/** One ceiling, forced inside what the engine will accept. */
export function clampCeiling(key: LoadTestCeilingKey, value: number): number {
	return Math.round(clampToRange(value, LOAD_TEST_CEILING_BOUNDS[key]));
}

/** Every ceiling clamped, for a stored object of unknown provenance. */
export function clampCeilings(ceilings: LoadTestCeilings): LoadTestCeilings {
	return {
		rps: clampCeiling("rps", ceilings.rps),
		concurrency: clampCeiling("concurrency", ceilings.concurrency),
		durationSeconds: clampCeiling("durationSeconds", ceilings.durationSeconds),
		iterations: clampCeiling("iterations", ceilings.iterations),
	};
}

/**
 * The dialog's effective ranges under a set of user ceilings.
 *
 * Ramp duration follows the duration ceiling and ramp start follows the
 * connection ceiling, because each pair measures the same physical quantity -
 * a separate knob for them would let a user set a target of 5000 connections
 * that the ramp could only start climbing towards from a capped 1000.
 */
export function resolveLoadTestLimits(ceilings: LoadTestCeilings): LoadTestLimits {
	const { rps, concurrency, durationSeconds, iterations } = clampCeilings(ceilings);
	return {
		...LOAD_TEST_LIMITS,
		RPS: { MIN: LOAD_TEST_LIMITS.RPS.MIN, MAX: rps },
		CONCURRENCY: { MIN: LOAD_TEST_LIMITS.CONCURRENCY.MIN, MAX: concurrency },
		START_CONCURRENCY: { MIN: LOAD_TEST_LIMITS.START_CONCURRENCY.MIN, MAX: concurrency },
		DURATION_S: { MIN: LOAD_TEST_LIMITS.DURATION_S.MIN, MAX: durationSeconds },
		RAMP_DURATION_S: { MIN: LOAD_TEST_LIMITS.RAMP_DURATION_S.MIN, MAX: durationSeconds },
		ITERATIONS: { MIN: LOAD_TEST_LIMITS.ITERATIONS.MIN, MAX: iterations },
	};
}
