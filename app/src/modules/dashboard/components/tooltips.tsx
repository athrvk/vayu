/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * tooltips - centralized InfoChip wording for every dashboard metric card and
 * chart: components import strings by key, they do not write tooltip copy
 * inline. This file is the authority for the wording itself - nothing outside
 * it pins a string - so an edit here is the whole change.
 *
 * Most entries are plain strings; a few carry inline markup and are therefore
 * ReactNode. Consume as: <InfoChip tip={TOOLTIPS.rateFidelity} />.
 */

import { type ReactNode } from "react";

export const TOOLTIPS = {
	// ---- Hero card #1 (mode-adaptive) ----
	rateFidelity: (
		<>
			Requests sent against requests owed over the sending window: the target rate times the
			time spent sending, up to the configured duration. 100% = every request the target
			called for went out. The end-of-run wait for slow responses is not counted, so a slow
			server does not lower it. Below ~95% means Vayu&apos;s engine couldn&apos;t send fast
			enough, or the in-flight cap dropped requests.
		</>
	),
	achievedThroughput:
		"Requests per second emerging from the configured virtual users. In closed-loop testing the rate is an output, not a target - the server's response time determines what RPS you actually achieve. Throughput per virtual user below shows what each one produced per second.",
	progress:
		"Requests sent so far, up to the requests the configured iterations would send. The bar fills as requests are sent, not as responses come back; ETA is projected from current throughput. The run ends on its own when its iterations finish.",
	currentConcurrency:
		"Virtual users active at this instant: each is waiting on a response or holding a think timer. On a finished run the card shows the peak instead, since nothing is active once it ends. The configured ramp climbs the number of virtual users linearly from the starting count to the target over the ramp duration. Ramp lag is the percentage of the configured curve that the generator failed to deliver - non-zero values mean the server is too slow to absorb the planned number of virtual users.",

	// ---- Hero card #2 (mode-adaptive) ----
	sendThroughput: (
		<>
			Twin rates from the open-model load generator. <b>Send</b> = requests dispatched onto
			the wire; <b>Throughput</b> = responses received. Live, both are averages since load
			started. A finished run compares them over the same window: the time spent sending,
			counting only the responses that had come back by the moment sending stopped. The chip
			beside them reads the last second or more live, and turns red only when responses fall
			behind sends by at least 1 req/s and 10% of the send rate for 3 seconds running.
			Responses always trail sends by one response time, so it stays grey until a response
			time has passed. A finished run&apos;s chip judges the two figures printed. A persistent
			gap means server-side saturation - the request queue (backpressure) grows.
		</>
	),
	sendThroughputDispatched: (
		<>
			Rate at which Vayu pushed requests onto the wire. Independent of how fast they come back
			- that&apos;s throughput.
		</>
	),
	sendThroughputReceived:
		"Rate at which responses arrived back from the server, the server's effective serve rate. On a finished run, received while sending counts the responses back by the moment sending stopped, over the sending window, so it sits beside dispatched like for like. Received, whole run (a run stored by an older engine) divides by the whole run, including the wait for the last responses, so it reads lower than dispatched by that wait.",
	queueChip:
		"Average time requests spent waiting in the generator's in-flight queue before being sent. Non-zero values mean the generator is queueing - usually because the server is slow to respond.",
	concurrencyUtil:
		"Of your configured N virtual users, how many had a request on the wire on average: the time the requests spent in flight divided by the time that passed. A virtual user waiting out a think or pacing timer, or between iterations, counts as idle for that time. Live it covers the last second or more; a finished run shows the whole run. Below 100% describes the run's shape, not a failure.",
	// Capacity discovery still shows the instant (#2818).
	concurrencyUtilInstant:
		"Of your configured N virtual users, how many were actually active on average. Below 100% means some virtual users were idle - usually because the load test was completing requests faster than it could re-fire (rare) or because the server occasionally returned errors that aborted iterations.",
	throughput:
		"Responses received per second since load started: so far while the run is live, the whole run once it has finished, including the wait for the last responses. In iterations mode, throughput is an output of how fast the server returns responses - there is no rate target.",
	latencyPercentiles:
		"Tail latency since the run started - 95 (p95) or 99 (p99) of every 100 timed requests finished in this time or less. A timed request got an answer or timed out; cancelled and never-sent requests are out. Real user-impact lives in the tail, not the mean; mean and median (sub-text) are misleading on heavy-tailed distributions.",
	saturation:
		"Whether the server has reached its capacity ceiling. In a ramp, 'healthy' means p99 latency is below the SLO threshold and the error rate is near zero, and 'degrading' means p99 has crossed the threshold or errors started; the call-out shows the number of virtual users at which that began (the breakpoint). A Capacity discovery run reads what ended its search and never says 'healthy': 'searching' until the search stops, 'degrading' when p99 or errors went over their limit, 'saturated' when more virtual users stopped adding throughput, and 'no limit found' when the search ran out of ceiling, time or patience before the target gave out. Errors that did not end the search are counted on their own line.",

	// ---- Hero card #3 (universal) ----
	errorRate:
		"Share of requests that count as errors: a response with a status outside 2xx and 3xx (HTTP errors), or no response at all (No response). A 3xx redirect is a success.",
	errorRateNoResponse:
		"Requests that got no response: a timeout, a refused connection, or a DNS or TLS failure. The server never sent an HTTP status.",

	// ---- Row 4 stat cards ----
	duration:
		"Time since load started, so setup scripts are not counted. For iterations mode this counts until all N requests complete; for the others it counts up to the configured duration. Setup is the time from the run's start to load start, including the setup script; cleanup is the time from load end to teardown finished.",
	totalRequests:
		"Cumulative count of requests dispatched and completed (success + failure). For iterations mode this approaches the configured target; for the others it grows with throughput.",
	peakVirtualUsers:
		"Most virtual users active at any point during the run, counting one a think timer is still holding. Backpressure shown beneath is the in-flight count right now: requests sent but not yet answered, plus any think-timer slots.",
	peakInFlight:
		"Maximum simultaneously in-flight requests at any point during the run, counting a slot a think timer is still holding. A Constant RPS run sends on a clock rather than from a fixed set of users, so this is requests, not virtual users. Backpressure shown beneath is that same in-flight count right now: requests sent but not yet answered, plus any think-timer slots.",
	throughputPerVu:
		"Achieved throughput divided by the configured number of virtual users - the average req/sec each one produced. A useful capacity number when planning for N real users.",
	remainingEta:
		"Estimated time to complete the remaining requests, computed as (requestsExpected - requestsSent) / currentRps. Updates each tick - a noisy ETA early in the run usually stabilises within 5–10s.",
	meanIterTime:
		"Average wall-clock time per iteration. Closely tracks p50 latency in closed-loop tests; divergence indicates queueing or other generator overhead.",
	breakpoint:
		'The number of virtual users at which p99 latency first crossed the configured SLO threshold (default 200ms). Use this as your capacity ceiling - beyond this load, response time grows nonlinearly. "not crossed" means p99 stayed under the SLO for the whole run, so the ceiling is above the load tested.',
	p99AtPeak:
		"The worst one-second p99 while the run was at its most virtual users. Unlike the breakpoint, which is read where p99 first crossed the SLO, this is the tail latency the full load produced. Until a second at that peak has a reading, it shows the run's p99 so far.",

	// ---- Chart cards ----
	throughputOverTime:
		"Send rate (dispatched) and throughput (received) over the last second, one point per tick. Divergence between the two lines indicates the server is saturating. The dashed reference is the configured target.",
	latencyOverTime:
		"Average latency of the requests that completed over the last second, one point per tick; a second with no completions adds no point. The amber gap between Latency and Wire shows queue wait: time spent in Vayu's generator or waiting for a free slot to the host before the request went on the wire. When the gap grows, Vayu was the bottleneck, not the server. Identity: latency = wire + queue wait.",
	percentilesOverTime:
		"p50 / p95 / p99 latency of each second of the run. p50 is what most users felt; p99 is the tail - heavy-tail divergence shows up as p99 climbing while p50 stays flat. At wider chart intervals each point shows the worst second in its interval. Sourced from HdrHistogram snapshots merged over each second.",
	responseTimeVsConcurrency:
		"Scatter plot - each dot is one second of the run. X axis is the number of virtual users at the end of that second; Y is that second's p99 latency. A flat left region means the server has headroom; the elbow (knee) is the breakpoint; the steep right region means the server is saturated. The amber vertical line marks where p99 first crossed the SLO threshold.",
	statusCodesOverTime:
		"Responses per second by status class, stacked: the plotted height is the running total, and hovering shows each class's own rate (classes with none in that interval are left out). A healthy run is a solid 2xx field; 4xx/5xx or connection-error bands rising out of it pinpoint when failures happened. Each response is counted in the second it completed, so where a tick fell does not move it; a point appears about a second after its second ends, and the last partial second of a run draws no point. Runs recorded by older versions are estimated from the change in the run's status-code totals between its once-a-second readings.",

	serverVitals:
		"Metrics scraped from the target itself during the run, drawn on the run's own timeline so a climb in p99 can be read against the server's CPU, memory or connection count. Each reading holds until the next scrape; a break in a line is a scrape that failed. Configure the endpoint under Server monitoring when starting the run.",

	customMetrics:
		"Custom trends, counters and rates a metric.record element or pm.metrics.trend / .counter / .rate call recorded, on the run's own timeline. A trend metric plots its p95; a counter or rate plots its one value. A gap is a bucket the metric never fired in, not a recorded zero.",

	// ---- Other existing cards ----
	rampDeviation:
		"Mean absolute gap between achieved (measured) and configured virtual users, as a percent of target. Counts both undershoot and overshoot, so a ramp that runs over target reads high.",
	latencyDistribution:
		"HDR percentile plot. X is percentile (log-scaled so the tail dominates); Y is latency. The curve's steepness from p95 → p99 is the tail story. Drawn through the min, p50, p75, p90, p95, p99, p99.9 and max points of the run's HdrHistogram, not a curve fitted to every sample.",
	avgRequestTiming:
		"Average breakdown of where each HTTP request spent time, in flight order. Averaged over every completion so far, which needs the phaseHistograms setting of Vayu's engine (on by default). Helps isolate whether latency lives in DNS, network setup, or the server.",
	phasePercentiles:
		"The same five phases as percentiles rather than averages, over every completion instead of the stored sample. A phase whose p99 towers over its p50 has a heavy tail an average hides: for TLS or Connect that is connection churn under load, a minority of requests paying a handshake the rest skipped; for TTFB it is the target's own slow tail. Requires the phaseHistograms setting of Vayu's engine.",
	streamEvents:
		"How many events each stream delivered, as a distribution over the run's streams - not the run's total. A p50 sitting exactly on the event cap means the cap, rather than the target, decided when every stream ended. Time to first event is the First byte row above: a stream's first byte is its first event's.",
} satisfies Record<string, ReactNode>;

export type TooltipKey = keyof typeof TOOLTIPS;
