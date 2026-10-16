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
 * One p99 reads the same wherever the app draws it (#2217): the History
 * header tile, the run-detail latency tile and the live dashboard's stat card.
 */

import { afterAll, describe, expect, it, vi } from "vitest";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the imports below run rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LoadTestDetail from "@/modules/history/main/LoadTestDetail";
import LatencyMetric from "@/modules/history/main/components/LatencyMetric";
import { P99StatCard } from "@/modules/dashboard/components/stats/ModeStatsRow";
import type { DashboardDerived } from "@/modules/dashboard/types";
import type { RunReport } from "@/types";

function report(p99: number): RunReport {
	return {
		metadata: {
			runId: "r",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			requestUrl: "http://127.0.0.1:8080/x",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 100,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 100,
		},
		latency: {
			min: 1,
			max: 1,
			avg: 1,
			median: 1,
			p50: 1,
			p75: 1,
			p90: 1,
			p95: 1,
			p99,
			p999: 1,
		},
		statusCodes: { "200": 100 },
		errors: { total: 0, withDetails: 0, types: {} },
	} as RunReport;
}

function historyHeaderTile(p99: number): string {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { unmount } = render(
		<QueryClientProvider client={qc}>
			<LoadTestDetail report={report(p99)} runId="r" />
		</QueryClientProvider>
	);
	const text = screen
		.getByText("P99 latency")
		.closest("div.bg-muted\\/50")
		?.querySelector("p")?.textContent;
	unmount();
	return text ?? "";
}

function latencyMetric(p99: number): string {
	const { container, unmount } = render(<LatencyMetric label="p99" value={p99} />);
	const text = container.querySelector("p.text-lg")?.textContent;
	unmount();
	return text ?? "";
}

function modeStatsCard(p99: number): string {
	const d = { p99Latency: p99, meanLatency: p99, medianLatency: p99 } as DashboardDerived;
	const { unmount } = render(<P99StatCard d={d} />);
	const text = screen
		.getByText("p99 latency")
		.closest("div")
		?.querySelector(".flex")?.textContent;
	unmount();
	return text ?? "";
}

describe("a p99 reads the same across the app", () => {
	it.each([
		[2.2749, "2.27ms"],
		[0.04, "0.04ms"],
		[1234, "1,234ms"],
		[108, "108ms"],
	])("%s", (p99, expected) => {
		expect(historyHeaderTile(p99)).toBe(expected);
		expect(latencyMetric(p99)).toBe(expected);
		expect(modeStatsCard(p99)).toBe(expected);
	});
});
