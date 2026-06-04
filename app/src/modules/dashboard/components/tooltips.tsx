/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * tooltips — centralized InfoChip wording for every dashboard metric card and
 * chart (Plan 4 code-quality gate #2: components import strings by key, they
 * do not write tooltip copy inline). Wording is locked in
 * docs/plans/4-dashboard-redesign.md §"Tooltip wording".
 *
 * Most entries are plain strings; a few carry inline markup and are therefore
 * ReactNode. Consume as: <InfoChip tip={TOOLTIPS.rateFidelity} />.
 */

import { type ReactNode } from "react";

export const TOOLTIPS = {
	// ---- Hero card #1 (mode-adaptive) ----
	rateFidelity: (
		<>
			How closely actual throughput tracked the target RPS. 100% = the engine hit the target
			exactly. Below ~95% means the engine couldn&apos;t keep up — either CPU-bound locally or
			the server is backpressuring.
		</>
	),
	achievedThroughput:
		"Requests per second emerging from the configured concurrent users. In closed-loop testing the rate is an output, not a target — the server's response time determines what RPS you actually achieve. Throughput / VU below shows what each simulated user produced per second.",
	progress:
		"Progress through the configured iteration count. The bar fills as requests complete; ETA is computed from current throughput. Once 100%, the test stops automatically.",
	currentConcurrency:
		"Current number of in-flight requests at this instant. The configured ramp climbs concurrency linearly from startConcurrency to the target over rampUpDuration. Ramp lag is the percentage of the configured curve that the generator failed to deliver — non-zero values mean the server is too slow to absorb the planned concurrency.",

	// ---- Hero card #2 (mode-adaptive) ----
	sendThroughput: (
		<>
			Twin rates from the open-model load generator. <b>Send</b> = requests dispatched onto
			the wire; <b>Throughput</b> = responses received. A persistent gap means server-side
			saturation — the request queue (backpressure) grows.
		</>
	),
	sendThroughputDispatched: (
		<>
			Rate at which Vayu pushed requests onto the wire. Independent of how fast they come back
			— that&apos;s throughput.
		</>
	),
	sendThroughputReceived:
		"Rate at which responses arrived back from the server. The server's effective serve rate.",
	queueChip:
		"Average time requests spent waiting in the generator's in-flight queue before being sent. Non-zero values mean the generator is queueing — usually because the server is slow to respond.",
	concurrencyUtil:
		"Of your configured N concurrent users, how many were actually in-flight on average. Below 100% means some VUs were idle — usually because the test was completing requests faster than it could re-fire (rare) or because the server occasionally returned errors that aborted iterations.",
	throughput:
		"Average requests per second across the run so far. In iterations mode, throughput is an output of how fast the server returns responses — there is no rate target.",
	saturation:
		"Whether the server has reached its capacity ceiling. 'Healthy' means p99 latency is below the SLO threshold and the error rate is near zero. 'Degrading' means p99 has crossed the threshold or errors started — the call-out shows the concurrency value at which the degradation began (the breakpoint).",

	// ---- Hero card #3 (universal) ----
	errorRate:
		"Share of requests that failed at the transport layer (timeout, connection refused, TLS handshake failure, DNS). HTTP responses with 4xx / 5xx status codes are counted separately in the bar below — they don't contribute to this percentage.",
	errorRateTransport:
		"Transport-layer failures (connection refused, TLS handshake error, DNS failure, timeout). The request never received an HTTP status from the server.",

	// ---- Row 4 stat cards ----
	duration:
		"Wall-clock time since the run started. For iterations mode this counts until all N requests complete; for the others it counts up to the configured duration.",
	totalRequests:
		"Cumulative count of requests dispatched and completed (success + failure). For iterations mode this approaches the configured target; for the others it grows with throughput.",
	peakConcurrency:
		"Maximum simultaneously in-flight requests at any point during the run. Backpressure shown beneath is the current queue depth (requests dispatched but not yet sent to curl).",
	p99Latency:
		"Tail latency — 99 of every 100 requests completed in this time or less. Real user-impact lives at p99, not the mean; mean (sub-text) is misleading on heavy-tailed distributions.",
	throughputPerVu:
		"Achieved throughput divided by configured concurrency — the average req/sec produced by each simulated user. A useful capacity number when planning for N real users.",
	remainingEta:
		"Estimated time to complete the remaining requests, computed as (requestsExpected - requestsSent) / currentRps. Updates each tick — a noisy ETA early in the run usually stabilises within 5–10s.",
	meanIterTime:
		"Average wall-clock time per iteration. Closely tracks p50 latency in closed-loop tests; divergence indicates queueing or other generator overhead.",
	breakpoint:
		"The current concurrency at which p99 latency first crossed the configured SLO threshold (default 200ms). Use this as your capacity ceiling — beyond this load, response time grows nonlinearly.",
	p99AtPeak:
		"Tail latency observed during the held-target portion of the ramp (after the curve flattens). Captures the latency this concurrency level actually produces, not just how it ramped up.",

	// ---- Chart cards ----
	throughputOverTime:
		"Per-tick (100ms) snapshot of send rate (dispatched) and throughput (received). Divergence between the two lines indicates the server is saturating. The dashed reference is the configured target.",
	latencyOverTime:
		"Per-tick latency over the run. The amber gap between Latency and Wire shows generator-side queue wait. When the gap grows, your generator is the bottleneck. Identity: latency = wire + queue wait.",
	percentilesOverTime:
		"Per-tick p50 / p95 / p99 latency over the run. p50 is what most users felt; p99 is the tail — heavy-tail divergence shows up as p99 climbing while p50 stays flat. Sourced from per-tick HdrHistogram snapshots.",
	responseTimeVsConcurrency:
		"Scatter plot — each dot is one tick. X axis is the concurrency at that moment; Y is p99 latency at that moment. A flat left region means the server has headroom; the elbow (knee) is the breakpoint; the steep right region means the server is saturated. The amber vertical line marks where p99 first crossed the SLO threshold.",
	statusCodesOverTime:
		"Per-interval count of responses by status class, stacked. A healthy run is a solid 2xx field; 4xx/5xx or connection-error bands rising out of it pinpoint when failures happened. Derived by diffing the cumulative status-code map between ticks.",

	// ---- Other existing cards ----
	rampDeviation:
		"Mean absolute gap between achieved (measured) and configured concurrency, as a percent of target. Counts both undershoot and overshoot, so a ramp that runs over target reads high.",
	latencyDistribution:
		"HDR percentile plot. X is percentile (log-scaled so the tail dominates); Y is latency. The curve's steepness from p95 → p99 is the tail story. Sourced from the engine's HdrHistogram.",
	avgRequestTiming:
		"Average breakdown of where each HTTP request spent time, in flight order. Computed across the timing-sampled subset of requests (enable save_timing_breakdown to populate). Helps isolate whether latency lives in DNS, network setup, or the server.",
} satisfies Record<string, ReactNode>;

export type TooltipKey = keyof typeof TOOLTIPS;
