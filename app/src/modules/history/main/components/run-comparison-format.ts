/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** How a compared metric is named and given its unit, for the strip and the full view alike. */

import { formatLatency, formatNumber, formatPercent, formatRate } from "@/lib/format-number";

/**
 * Both rates divide by `testDuration`, drain included, so they say so: beside
 * the Send / Throughput card's sending-window pair (#2882) a bare "Response
 * rate" reads as the same figure. `COMPARED_FORMATS` in
 * `engine/src/core/run_export_view.cpp` copies these labels.
 */
export const METRIC_LABELS: Record<string, string> = {
	"latency.p50": "P50 latency",
	"latency.p90": "P90 latency",
	"latency.p95": "P95 latency",
	"latency.p99": "P99 latency",
	"latency.avg": "Average latency",
	"latency.max": "Max latency",
	"summary.avgRps": "Throughput (whole run, drain included)",
	"summary.throughput": "Response rate (whole run, drain included)",
	"summary.errorRate": "Error rate",
	"summary.totalRequests": "Total requests",
	"stream.timeToFirstEvent.p50": "Time to first event (P50)",
	"stream.timeToFirstEvent.p95": "Time to first event (P95)",
	"stream.timeToFirstMatch.p50": "Time to first match (P50)",
	"stream.timeToFirstMatch.p95": "Time to first match (P95)",
	"stream.maxEventGap.p95": "Longest gap between events (P95)",
	"stream.eventRate.p50": "Events per second, per stream (P50)",
	"stream.eventsPerSecond": "Events per second (whole run)",
	"stream.events.p50": "Events per stream (P50)",
};

const CUSTOM_METRIC_PREFIX = "customMetrics.";

/**
 * A row's name: the fixed label, or for `customMetrics.<name>.<field>` the script's own name, which
 * may itself contain dots (the field is the last segment) and is the user's text, never markup.
 */
export function metricLabel(metric: string): string {
	const fixed = METRIC_LABELS[metric];
	if (fixed !== undefined) return fixed;
	if (!metric.startsWith(CUSTOM_METRIC_PREFIX)) return metric;
	const path = metric.slice(CUSTOM_METRIC_PREFIX.length);
	const dot = path.lastIndexOf(".");
	if (dot < 0) return metric;
	const name = path.slice(0, dot);
	const field = path.slice(dot + 1);
	return field === "value" ? name : `${name} (${field.toUpperCase()})`;
}

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
	if (/^stream\.(timeToFirst|maxEventGap)/.test(metric)) return formatSignedLatency(value);
	if (metric === "stream.eventRate.p50" || metric === "stream.eventsPerSecond") {
		return `${formatRate(value)} events/s`;
	}
	return formatNumber(value);
}
