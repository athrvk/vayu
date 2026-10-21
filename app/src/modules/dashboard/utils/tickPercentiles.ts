/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one reading of a tick's latency percentiles (issue #2385).
 *
 * A tick's `latency_p*_ms` mean different things by where the tick came from:
 * a stored tick holds its whole second's percentiles, while a live frame holds
 * only the last ~100 ms window - a tenth of the second, which plotted beside a
 * stored series is a different quantity under the same name. Every reader that
 * wants a per-second figure (the percentile chart, the response-time scatter,
 * the breakpoint, the anomaly detector's p99) goes through
 * {@link secondPercentiles}, and the hero card's run-so-far figures through
 * {@link cumulativePercentiles}, so no chart or threshold re-derives the
 * distinction inline.
 */

import type { LoadTestMetrics } from "@/types";

export interface PercentileTriple {
	p50: number;
	p95: number;
	p99: number;
}

/**
 * True when the tick stands for a whole second: a gate frame (`second_samples`
 * present) or a stored tick. Any other live frame is a ~100 ms window.
 */
export const coversSecond = (m: LoadTestMetrics): boolean =>
	m.second_samples !== undefined || !m.live;

/**
 * The tick's whole-second percentiles, or `null` when the tick holds none.
 *
 * - A gate frame holds its second's figures, or none when nothing completed.
 * - Any other live frame holds only a window, which is no second's figure.
 * - A stored tick's own `latency_p*_ms` are its second's already, and are
 *   absent for a second with no completion (issue #2386). A row an older
 *   engine wrote holds `0` there, which reads as the number it is.
 *
 * {@link coversSecond} without percentiles is an empty second: a gap in a
 * chart, never a 0 ms reading.
 */
export function secondPercentiles(m: LoadTestMetrics): PercentileTriple | null {
	if (m.second_samples !== undefined) {
		if (m.second_samples <= 0) return null;
		return triple(m.second_p50_ms, m.second_p95_ms, m.second_p99_ms);
	}
	if (m.live) return null;
	return triple(m.latency_p50_ms, m.latency_p95_ms, m.latency_p99_ms);
}

function triple(
	p50: number | null | undefined,
	p95: number | null | undefined,
	p99: number | null | undefined
): PercentileTriple | null {
	if (p50 == null || p95 == null || p99 == null) return null;
	return { p50, p95, p99 };
}

/** True when the tick holds a whole-second figure to plot or judge. */
export const hasSecondPercentiles = (m: LoadTestMetrics): boolean => secondPercentiles(m) !== null;

/**
 * The worse of two percentile readings, where `null` is no reading: a bucket
 * merging an empty second with a measured one keeps the measurement, and a
 * bucket of empty seconds stays empty rather than becoming 0 ms.
 */
export function worstReading(a: number | null, b: number | null): number | null {
	if (a == null) return b;
	if (b == null) return a;
	return Math.max(a, b);
}

/**
 * The percentiles over the run so far, the span `avg_latency_ms` covers.
 *
 * A live frame carries them on every frame, `null` until something has
 * completed, which reads as 0 here because the card prints 0 as "awaiting
 * samples". A tick without the keys (a stored one) falls back to its own
 * `latency_p*_ms`, and an empty second's absent ones read as 0 the same way.
 */
export function cumulativePercentiles(
	m: Pick<
		LoadTestMetrics,
		| "latency_p50_ms"
		| "latency_p95_ms"
		| "latency_p99_ms"
		| "cumulative_p50_ms"
		| "cumulative_p95_ms"
		| "cumulative_p99_ms"
	>
): PercentileTriple {
	if (m.cumulative_p99_ms === undefined) {
		return {
			p50: m.latency_p50_ms ?? 0,
			p95: m.latency_p95_ms ?? 0,
			p99: m.latency_p99_ms ?? 0,
		};
	}
	return {
		p50: m.cumulative_p50_ms ?? 0,
		p95: m.cumulative_p95_ms ?? 0,
		p99: m.cumulative_p99_ms ?? 0,
	};
}
