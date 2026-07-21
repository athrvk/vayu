/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dashboard's final-report fetch must give up, and must say so.
 *
 * It had a `try`/`finally` with no `catch`. On a throw, `finally` cleared
 * `isLoadingReport`; that is an effect dependency, so the effect re-ran, the
 * guard `!finalReport && !isLoadingReport` was true again, and it refetched.
 * `loadAttemptRef` was only incremented on the zero-data path, never on a
 * failure, so the attempt cap never engaged — a persistent failure retried
 * forever while the dashboard sat empty.
 *
 * Rendering the dashboard needs the SSE stream, the run store and uPlot, so
 * this models the loop as the reducer it is. That is honest about what it
 * covers: the arithmetic of giving up, not the wiring.
 */

import { describe, it, expect } from "vitest";
import { TIMING } from "@/config/timing";

interface State {
	attempts: number;
	error: string | null;
	fetches: number;
}

/** One pass of the effect, as it is written after the fix. */
function attemptFetch(state: State, outcome: "throws" | "succeeds"): State {
	// The guard at the top of the effect.
	if (state.error) return state;

	const next = { ...state, fetches: state.fetches + 1 };
	if (outcome === "succeeds") return { ...next, attempts: 0 };

	if (next.attempts < TIMING.REPORT_MAX_ATTEMPTS) {
		return { ...next, attempts: next.attempts + 1 };
	}
	return { ...next, attempts: 0, error: "Could not load the run report" };
}

const run = (outcome: "throws" | "succeeds", times: number) => {
	let state: State = { attempts: 0, error: null, fetches: 0 };
	for (let i = 0; i < times; i++) state = attemptFetch(state, outcome);
	return state;
};

describe("final report retry", () => {
	it("stops after the capped number of attempts", () => {
		const state = run("throws", 50);
		expect(state.error).not.toBeNull();
		// Cap + 1: the attempts are spent, then the next failure surfaces it.
		expect(state.fetches).toBe(TIMING.REPORT_MAX_ATTEMPTS + 1);
	});

	it("does not keep fetching once the failure is surfaced", () => {
		const settled = run("throws", 50);
		const after = attemptFetch(settled, "throws");
		expect(after.fetches).toBe(settled.fetches);
	});

	it("resets the counter on success, so a later run starts fresh", () => {
		let state = run("throws", 2);
		expect(state.attempts).toBe(2);
		state = attemptFetch(state, "succeeds");
		expect(state.attempts).toBe(0);
		expect(state.error).toBeNull();
	});

	it("uses a cap that is finite and small", () => {
		// The bug was an unbounded loop; a huge cap would be the same defect.
		expect(TIMING.REPORT_MAX_ATTEMPTS).toBeGreaterThan(0);
		expect(TIMING.REPORT_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
	});
});
