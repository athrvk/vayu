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
 * A stored capacity run is judged against the budget its own search stopped on
 * (`report.capacity.sloMs`), not the Settings SLO (#2816): the Capacity summary
 * already printed the run's figure, while the breakpoint, the chart lines and
 * the latency tiles read the setting and drew a second, different budget.
 *
 * Any other run draws an SLO line only where it declared a p99 budget
 * (`thresholdValidation`'s `latencyP99Ms` check); the Settings SLO is a client
 * preference, so a run without a budget draws no line, no legend entry and no
 * coloured tile, whatever Settings holds (#2939).
 *
 * Real charts, `UPlotChart` swapped for a recorder, so the lines are read off
 * the markers the charts were handed. The Settings SLO is 200 ms throughout and
 * the run's own 50 ms, with p99 crossing 50 and never 200, so a reader of the
 * setting is the only thing that can draw 200 here.
 *
 * Mutation-check: judge with the setting in `LoadTestDetail` (drop the
 * `report.capacity?.sloMs ??`) and the line, marker and tile cases fail; read
 * the setting in `PerformanceTab` (`sloMs = derived.runSloMs ?? settingSloMs`)
 * and the tile case and the no-budget cases fail.
 */

import { useId } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { useClientSettingsStore } from "@/stores";
import type { LoadTestMetrics, RunReport } from "@/types";
import type { Marker } from "@/modules/dashboard/components/charts/uplot/plugins";

const charts = vi.hoisted(() => new Map<string, { markers?: Marker[] }>());
const series = vi.hoisted(() => ({ current: [] as LoadTestMetrics[] }));

vi.mock("@/modules/dashboard/components/charts/uplot/UPlotChart", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/modules/dashboard/components/charts/uplot/UPlotChart")
	>()),
	UPlotChart: (props: { markers?: Marker[] }) => {
		const id = useId();
		charts.set(id, props);
		return <div data-chart-id={id} />;
	},
}));

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		data: {
			data: series.current,
			pagination: {
				total: series.current.length,
				limit: 2000,
				offset: 0,
				hasMore: false,
				returned: series.current.length,
			},
			bucketed: false,
			ticksPerBucket: 1,
		},
		isLoading: false,
	}),
	useRunMonitorSeriesQuery: () => ({ data: undefined }),
	useRunQuery: () => ({ data: undefined }),
	useBaselineRunQuery: () => ({ data: undefined }),
	useRunReportQuery: () => ({ data: undefined }),
	useRequestRunsQuery: () => ({ data: undefined }),
}));

const LoadTestDetail = (await import("./LoadTestDetail")).default;

/** p99 climbs 10, 20, 30, 40, 60, 80: over the run's 50 ms at the fifth tick, never over 200 ms. */
function climbingTicks(): LoadTestMetrics[] {
	return [10, 20, 30, 40, 60, 80].map((p99, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: 0,
		current_rps: 100,
		current_concurrency: (i + 1) * 10,
		latency_p50_ms: 5,
		latency_p95_ms: 8,
		latency_p99_ms: p99,
		avg_latency_ms: 6,
		bytes_sent: 0,
		bytes_received: 0,
	}));
}

function report(mode: string, capacity?: RunReport["capacity"], p99BudgetMs?: number): RunReport {
	return {
		metadata: {
			runId: "run_cap",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 6000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
			configuration: { mode },
		},
		summary: {
			totalRequests: 600,
			failedRequests: 0,
			requestsPerSecond: 100,
			testDuration: 6,
			errorRate: 0,
		},
		// p99 60 is over the run's 50 ms and under the setting's 200 ms.
		latency: { min: 1, max: 90, avg: 10, p50: 8, p90: 30, p95: 40, p99: 60 },
		capacity,
		...(p99BudgetMs !== undefined && {
			thresholdValidation: {
				checks: [{ metric: "latencyP99Ms", limit: p99BudgetMs, actual: 60, passed: false }],
				passed: 0,
				failed: 1,
				verdict: "failed",
			},
		}),
	} as unknown as RunReport;
}

const CAPACITY: NonNullable<RunReport["capacity"]> = {
	sloMs: 50,
	stopReason: "slo_exceeded",
	levels: [],
};

function openPerformance(value: RunReport) {
	render(withQueryClient(<LoadTestDetail report={value} runId="run_cap" />));
	fireEvent.mouseDown(screen.getByRole("tab", { name: /performance/i }), { button: 0 });
}

const labels = (orient: Marker["orient"]) =>
	[...charts.values()].flatMap((c) =>
		(c.markers ?? []).filter((m) => m.orient === orient).map((m) => m.label)
	);

/** The key under the percentile and scatter cards: the SLO is an entry only where a line is drawn. */
const legendLabels = () =>
	[...document.querySelectorAll("[data-legend-role]")].map((e) => e.textContent);

const p99Tile = () => screen.getByText("P99", { exact: true }).parentElement as HTMLElement;
const isDanger = () => p99Tile().innerHTML.includes("status-error");

beforeEach(() => {
	charts.clear();
	series.current = climbingTicks();
	useClientSettingsStore.setState({ sloThresholdMs: 200 });
});

describe("a stored capacity run against its own SLO (#2816)", () => {
	it("draws the SLO line and the crossing at the run's budget, not the setting's", async () => {
		openPerformance(report("capacity", CAPACITY));

		await screen.findByText("Latency distribution");
		expect(labels("horizontal")).toContain("SLO 50ms");
		expect(labels("horizontal")).not.toContain("SLO 200ms");
		expect(labels("vertical")).toContain("p99 > SLO 50ms");
	});

	it("colours the p99 tile against the run's budget", async () => {
		openPerformance(report("capacity", CAPACITY));

		await screen.findByText("Latency distribution");
		expect(isDanger()).toBe(true);
	});

	it("draws no SLO line, key entry or coloured tile for a run with no p99 budget, though p99 is over the setting", async () => {
		// p99 60 is over this setting and the run declared no line of its own.
		useClientSettingsStore.setState({ sloThresholdMs: 30 });
		openPerformance(report("constant_concurrency"));

		await screen.findByText("Latency distribution");
		expect(labels("horizontal")).toEqual([]);
		expect(legendLabels()).toContain("p99");
		expect(legendLabels()).not.toContain("SLO");
		expect(isDanger()).toBe(false);
	});

	it("draws the run's p99 budget as its SLO line, key entry and tile verdict, not the setting", async () => {
		useClientSettingsStore.setState({ sloThresholdMs: 200 });
		openPerformance(report("constant_concurrency", undefined, 50));

		await screen.findByText("Latency distribution");
		expect(labels("horizontal")).toEqual(["SLO 50ms"]);
		expect(legendLabels()).toContain("SLO");
		expect(isDanger()).toBe(true);
	});

	it("draws the SLO line a p99 budget names above the setting's, and leaves a tile under it neutral", async () => {
		useClientSettingsStore.setState({ sloThresholdMs: 30 });
		openPerformance(report("constant_concurrency", undefined, 350));

		await screen.findByText("Latency distribution");
		expect(labels("horizontal")).toEqual(["SLO 350ms"]);
		expect(isDanger()).toBe(false);
	});
});

describe("a stored run's crossing names whose line it was judged against (#2939)", () => {
	// Mutation-check: drop `runSloMs(report)` from `computeBreakpoint` in
	// `LoadTestDetail` and the matching-budget case reads Settings'; force the
	// source to "run" in `sloSourceOf` and the two Settings cases fail.
	it("calls the Settings threshold what it is when the run declared no p99 line", async () => {
		useClientSettingsStore.setState({ sloThresholdMs: 30 });
		openPerformance(report("constant_concurrency"));

		await screen.findByText("Latency distribution");
		expect(labels("vertical")).toContain("p99 > 30ms threshold in Settings");
	});

	it("still judges by Settings, and says so, when the p99 budget is a different number", async () => {
		useClientSettingsStore.setState({ sloThresholdMs: 30 });
		openPerformance(report("constant_concurrency", undefined, 350));

		await screen.findByText("Latency distribution");
		expect(labels("vertical")).toContain("p99 > 30ms threshold in Settings");
		expect(labels("vertical")).not.toContain("p99 > SLO 30ms");
	});

	it("calls it the SLO where the judged number is the run's own p99 budget", async () => {
		useClientSettingsStore.setState({ sloThresholdMs: 30 });
		openPerformance(report("constant_concurrency", undefined, 30));

		await screen.findByText("Latency distribution");
		expect(labels("vertical")).toContain("p99 > SLO 30ms");
	});
});

describe("a stored capacity run's Saturation card (#2816)", () => {
	// Mutation-check: drop `capacity` from `reportToDerived`, or mount the ramp's
	// card in HeroRow's capacity case, and these fail.
	it("reads the stop reason the report stored, not the ticks", () => {
		render(
			withQueryClient(
				<LoadTestDetail
					report={report("capacity", {
						...CAPACITY,
						kneeConcurrency: 50,
						kneeP99Ms: 60,
					})}
					runId="run_cap"
				/>
			)
		);

		expect(screen.getByText("⚠ degrading")).toBeTruthy();
		expect(screen.getByText("(the 50ms SLO)", { exact: false })).toBeTruthy();
		expect(screen.queryByText("✓ healthy")).toBeNull();
	});

	it("says no limit found, in words, for a search that ran out of ceiling", () => {
		render(
			withQueryClient(
				<LoadTestDetail
					report={report("capacity", { ...CAPACITY, stopReason: "cap_reached" })}
					runId="run_cap"
				/>
			)
		);

		expect(screen.getByText("no limit found")).toBeTruthy();
		expect(screen.queryByText("✓ healthy")).toBeNull();
	});
});
