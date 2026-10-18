/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The finished run's dividers read on the card they sit on (#1891). The HDR
 * footer, the phase percentiles and the stream events moved here from the
 * dashboard's report (#2220), and each draws a `border-rule` that falls back
 * to the invisible default under no declared surface.
 *
 * `Card` declares `surface-card` itself (#2294), so the cards here need no
 * class of their own. Mutation-check: drop `surface-card` from `card.tsx` and
 * this fails.
 */

import { describe, it, expect } from "vitest";
import { render } from "@/test/render-with-tooltips";
import PerformanceTab from "./PerformanceTab";
import type { RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

const phase = { p50: 2, p95: 3, p99: 4, max: 6, count: 100 };

const report = {
	metadata: { runId: "run_1", runType: "load", status: "completed" },
	summary: { totalRequests: 100, failedRequests: 0, testDuration: 10, errorRate: 0 },
	latency: { min: 1, max: 9, avg: 4, p50: 4, p90: 7, p95: 8, p99: 9 },
	timingBreakdown: {
		avgDnsMs: 1,
		avgConnectMs: 2,
		avgTlsMs: 3,
		avgFirstByteMs: 10,
		avgDownloadMs: 4,
		phases: { dns: phase, connect: phase, tls: phase, firstByte: phase, download: phase },
	},
	stream: {
		completions: 3,
		totalEvents: 120,
		capped: 0,
		eventsPerSecond: 12.5,
		events: { min: 1, max: 60, p50: 40, p90: 55, p95: 58, p99: 60, count: 3 },
	},
} as unknown as RunReport;

describe("PerformanceTab declares the surface its dividers read", () => {
	it("every border-rule sits under a declared surface", () => {
		// `runId` is left off so the uPlot charts stay out of the tree.
		const { container } = render(
			<PerformanceTab
				report={report}
				derived={
					{ mode: "constant_concurrency", targetRps: 0 } as unknown as DashboardDerived
				}
				timeSeries={[]}
				monitorSamples={[]}
			/>
		);
		const rules = Array.from(container.querySelectorAll(".border-rule"));

		// HDR footer, phase percentiles and stream events: a render that reached
		// none of them would pass the loop below having checked nothing.
		expect(rules.length).toBeGreaterThanOrEqual(3);
		for (const rule of rules) {
			expect(
				rule.closest(".surface-card, .surface-sunken"),
				`border-rule under no surface: ${rule.getAttribute("class")}`
			).not.toBeNull();
		}
	});
});
