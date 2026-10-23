/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Gate-frame fixtures shared by the `liveDistributions` and Row 3 tests. */

import type { LiveLatencyDistribution, LivePhaseDistributions, LoadTestMetrics } from "@/types";

export const LATENCY: LiveLatencyDistribution = {
	minMs: 1,
	p50Ms: 5,
	p75Ms: 8,
	p90Ms: 12,
	p95Ms: 20,
	p99Ms: 40,
	p999Ms: 90,
	maxMs: 120,
	count: 600,
};

const phase = (meanMs: number) => ({
	meanMs,
	p50Ms: meanMs,
	p95Ms: meanMs,
	p99Ms: meanMs,
	count: 600,
});
export const PHASES: LivePhaseDistributions = {
	dns: phase(0.1),
	connect: phase(0.2),
	tls: phase(0.3),
	firstByte: phase(3.1),
	download: phase(0.4),
};

export function tick(elapsed: number, extra: Partial<LoadTestMetrics> = {}): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		avg_latency_ms: 7,
		bytes_sent: 0,
		bytes_received: 0,
		live: true,
		...extra,
	};
}
