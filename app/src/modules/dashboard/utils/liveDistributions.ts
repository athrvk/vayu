/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the live view's Row 3 cards draw: the run-so-far latency distribution and
 * the per-phase means and percentiles, which the engine sends on the gate frame
 * alone (issue #2782).
 *
 * The newest tick is almost never a gate frame (about one in ten), so a reader
 * of `metrics` would flicker between the cards' data and nothing. The adapters
 * below take the latest frame that carries the key, and return the shapes the
 * History cards already take (`Pick<RunReport, ...>`), so the live and stored
 * views share one chart, one waterfall and one percentile table.
 */

import type { LivePhaseDistributions, LoadTestMetrics, RunReport } from "@/types";

/** The latest gate frame in the buffer, or `undefined` before the first. */
export function latestGateFrame(history: readonly LoadTestMetrics[]): LoadTestMetrics | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		// `null` ("nothing completed yet") still marks a gate frame; only an
		// absent key means the frame is not one.
		if (history[i].cumulative_latency !== undefined) return history[i];
	}
	return undefined;
}

/**
 * The phase card's three states. `off` is a gate frame without the key: the run
 * has phase histograms off, which is "not measured" and not "nothing yet".
 */
export type LivePhaseTiming =
	| { kind: "waiting" }
	| { kind: "off" }
	| { kind: "ready"; report: Pick<RunReport, "timingBreakdown"> };

export interface LiveDistributions {
	/**
	 * `null` until a completion has been recorded. `count` is the completions
	 * behind the distribution, which the report shape has no field for.
	 */
	latency: (Pick<RunReport, "latency"> & { count: number }) | null;
	phases: LivePhaseTiming;
}

/**
 * The cards' data from a gate frame; `undefined` (no gate frame yet) reads as
 * waiting. The mean comes from the same frame's `avg_latency_ms`, since the
 * distribution carries none, so the footer and the curve describe one instant.
 */
export function liveDistributions(frame: LoadTestMetrics | undefined): LiveDistributions {
	return {
		latency: liveLatency(frame),
		phases: livePhaseTiming(frame),
	};
}

function liveLatency(frame: LoadTestMetrics | undefined): LiveDistributions["latency"] {
	const d = frame?.cumulative_latency;
	if (!frame || !d) return null;
	return {
		latency: {
			min: d.minMs,
			max: d.maxMs,
			avg: frame.avg_latency_ms,
			p50: d.p50Ms,
			p75: d.p75Ms,
			p90: d.p90Ms,
			p95: d.p95Ms,
			p99: d.p99Ms,
			p999: d.p999Ms,
		},
		count: d.count,
	};
}

function livePhaseTiming(frame: LoadTestMetrics | undefined): LivePhaseTiming {
	if (!frame) return { kind: "waiting" };
	const phases = frame.cumulative_phases;
	if (phases === undefined) return { kind: "off" };
	if (phases === null) return { kind: "waiting" };
	return {
		kind: "ready",
		report: {
			timingBreakdown: {
				avgDnsMs: phases.dns.meanMs,
				avgConnectMs: phases.connect.meanMs,
				avgTlsMs: phases.tls.meanMs,
				avgFirstByteMs: phases.firstByte.meanMs,
				avgDownloadMs: phases.download.meanMs,
				phases: reportPhases(phases),
			},
		},
	};
}

type ReportPhases = NonNullable<NonNullable<RunReport["timingBreakdown"]>["phases"]>;

/** The report's `timingBreakdown.phases` shape from a frame's wire spelling. */
function reportPhases(phases: LivePhaseDistributions): ReportPhases {
	const out: ReportPhases = {};
	for (const key of Object.keys(phases) as (keyof LivePhaseDistributions)[]) {
		const d = phases[key];
		out[key] = { p50: d.p50Ms, p95: d.p95Ms, p99: d.p99Ms, max: d.maxMs, count: d.count };
	}
	return out;
}
