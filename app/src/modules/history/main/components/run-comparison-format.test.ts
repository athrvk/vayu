/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it } from "vitest";
import { formatPercent } from "@/lib/format-number";
import { formatValue, metricLabel } from "./run-comparison-format";

describe("formatValue", () => {
	it("draws a latency through formatLatency, unit unspaced", () => {
		expect(formatValue("latency.p95", 42)).toBe("42ms");
		expect(formatValue("latency.p99", 1234)).toBe("1.23s");
	});

	it("switches a negative latency delta to seconds where a positive one does", () => {
		expect(formatValue("latency.p95", -1500)).toBe("-1.50s");
		expect(formatValue("latency.p95", -300)).toBe("-300ms");
	});

	it("draws the error rate through formatPercent, one decimal", () => {
		expect(formatValue("summary.errorRate", 1)).toBe(`${formatPercent(1)}%`);
		expect(formatValue("summary.errorRate", 1)).toMatch(/^1[.,]0%$/);
	});
});

describe("stream figures", () => {
	it("draws the waits and the longest gap as latencies", () => {
		expect(formatValue("stream.timeToFirstEvent.p50", 120)).toBe("120ms");
		expect(formatValue("stream.timeToFirstMatch.p95", 1500)).toBe("1.50s");
		expect(formatValue("stream.maxEventGap.p95", -300)).toBe("-300ms");
	});

	it("draws both rates per second and the event count bare", () => {
		expect(formatValue("stream.eventRate.p50", 36)).toBe("36 events/s");
		expect(formatValue("stream.eventsPerSecond", 7.5)).toBe("7.5 events/s");
		expect(formatValue("stream.events.p50", 20)).toBe("20");
	});
});

describe("metricLabel", () => {
	it("names a fixed metric by its label", () => {
		expect(metricLabel("latency.p95")).toBe("P95 latency");
		expect(metricLabel("stream.timeToFirstEvent.p50")).toBe("Time to first event (P50)");
	});

	it("names a custom metric by the script's name, with the percentile for a trend", () => {
		expect(metricLabel("customMetrics.hits.value")).toBe("hits");
		expect(metricLabel("customMetrics.ttfb.p95")).toBe("ttfb (P95)");
	});

	it("keeps a dotted custom name whole", () => {
		expect(metricLabel("customMetrics.http.reqs.value")).toBe("http.reqs");
	});

	it("returns a metric it has no label for as it came", () => {
		expect(metricLabel("summary.other")).toBe("summary.other");
		expect(metricLabel("customMetrics.broken")).toBe("customMetrics.broken");
	});
});
