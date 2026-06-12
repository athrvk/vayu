/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { LoadTestMetrics } from "@/types";

/** Default SLO threshold (ms) at which p99 is considered to have degraded. */
export const DEFAULT_SLO_MS = 200;

/**
 * The capacity breakpoint of a ramp_up run: the first per-tick moment at which
 * p99 latency crossed the SLO threshold, and the concurrency in flight then.
 * Consumed by the Saturation hero card (A1), the Breakpoint stat (A2), and the
 * Response-time-vs-concurrency scatter's SLO line (A3) — one definition, three
 * call sites.
 */
export interface Breakpoint {
	crossed: boolean;
	/** Concurrency at the crossing tick; null if never crossed. */
	concurrency: number | null;
	/** Elapsed seconds at the crossing tick; null if never crossed. */
	timeSeconds: number | null;
	/** p99 (ms) observed at the crossing tick; null if never crossed. */
	p99Ms: number | null;
}

/**
 * Scan per-tick history for the first tick whose p99 exceeds `thresholdMs`.
 * History is assumed time-ordered (as it arrives over SSE).
 */
export function computeBreakpoint(
	history: LoadTestMetrics[],
	thresholdMs: number = DEFAULT_SLO_MS
): Breakpoint {
	for (const m of history) {
		const p99 = m.latency_p99_ms ?? 0;
		if (p99 > thresholdMs) {
			return {
				crossed: true,
				concurrency: m.current_concurrency,
				timeSeconds: m.elapsed_seconds,
				p99Ms: p99,
			};
		}
	}
	return { crossed: false, concurrency: null, timeSeconds: null, p99Ms: null };
}
