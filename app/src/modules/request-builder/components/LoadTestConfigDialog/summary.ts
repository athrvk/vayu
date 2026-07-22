/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One live sentence describing the run being configured.
 *
 * Replaces the "What will happen:" box, which restated the fields in prose and
 * sat five controls below them. Two things justify keeping a summary at all:
 *
 *   - **Ramp-Up's semantics are genuinely non-obvious.** The ramp runs *inside*
 *     the total, so a 30s ramp in a 60s run means 30s ramping and 30s at target.
 *   - **It can state the total request count**, which no single field shows.
 *
 * The count is only stated where it is knowable. `constant_concurrency` and
 * `ramp_up` send as many requests as the target can answer, which depends on
 * latency - guessing there would be worse than saying nothing.
 */

import type { LoadTestConfig } from "@/types";

export interface SummaryInput {
	mode: LoadTestConfig["mode"];
	duration: number;
	rps: number;
	concurrency: number;
	iterations: number;
	rampDuration: number;
	startConcurrency: number;
}

/** `6000` → `"6,000"`. Grouped because these run to five and six figures. */
function count(n: number): string {
	return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${count(n)} ${n === 1 ? one : many}`;
}

/**
 * @param blocked  When a validation error is live the numbers describe a run
 *                 that cannot start, so the estimate is withheld rather than
 *                 printed as a confident falsehood.
 */
export function summarise(input: SummaryInput, blocked = false): string {
	const { mode, duration, rps, concurrency, iterations, rampDuration, startConcurrency } = input;

	if (mode === "iterations") {
		return `Sends exactly ${plural(iterations, "request")} using ${plural(
			concurrency,
			"connection"
		)}, then stops.`;
	}

	if (mode === "constant_rps") {
		const shape = `Holds ${count(rps)} requests/sec for ${count(duration)}s`;
		if (blocked) return `${shape}.`;
		return `${shape} - about ${plural(rps * duration, "request")} in total.`;
	}

	if (mode === "constant_concurrency") {
		// No count: throughput here is whatever the target can serve.
		return `Keeps ${plural(concurrency, "connection")} busy for ${count(
			duration
		)}s. Total requests depend on how fast the target responds.`;
	}

	// ramp_up - the one case where the old prose was earning its keep.
	const atTarget = duration - rampDuration;
	const tail = atTarget > 0 ? ` then holds it for the remaining ${count(atTarget)}s` : "";
	return `Climbs from ${count(startConcurrency)} to ${plural(
		concurrency,
		"connection"
	)} over ${count(rampDuration)}s${tail}, within a ${count(
		duration
	)}s run. The ramp counts towards the total.`;
}
