/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** How a compared metric is named and given its unit, for the strip and the full view alike. */

import { formatLatency, formatNumber, formatPercent, formatRate } from "@/lib/format-number";

export const METRIC_LABELS: Record<string, string> = {
	"latency.p50": "P50 latency",
	"latency.p90": "P90 latency",
	"latency.p95": "P95 latency",
	"latency.p99": "P99 latency",
	"latency.avg": "Average latency",
	"latency.max": "Max latency",
	"summary.avgRps": "Throughput",
	"summary.throughput": "Response rate",
	"summary.errorRate": "Error rate",
	"summary.totalRequests": "Total requests",
};

/** A negative delta switches unit at the same point a positive one does ("-1.50s", not "-1,500ms"). */
function formatSignedLatency(ms: number): string {
	return ms < 0 ? `-${formatLatency(-ms)}` : formatLatency(ms);
}

/** Units belong to the metric, not to the delta arithmetic. */
export function formatValue(metric: string, value: number): string {
	if (metric.startsWith("latency.")) return formatSignedLatency(value);
	if (metric === "summary.avgRps" || metric === "summary.throughput") {
		return `${formatRate(value)} rps`;
	}
	if (metric === "summary.errorRate") return `${formatPercent(value)}%`;
	return formatNumber(value);
}
