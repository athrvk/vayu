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
 * The Performance tab's time charts carry the key the live dashboard gives the
 * same charts (#2697): `MetricsView` legended them (#2311) and History drew the
 * identical series bare, so a reader of a finished run had to guess which line
 * was p95.
 *
 * Real charts, `UPlotChart` swapped for a recorder, so each legend is read
 * against the series the chart of its own card was handed. The throughput key
 * lists only what History's chart draws: it is told no target and no ramp, so a
 * "target" or "achieved" entry would label a line that is not there (#2393).
 *
 * Mutation-check: drop the `ChartLegend` from the percentile card, the scatter
 * card or the request-rate card in History and the case for that card fails;
 * pass `throughputLegend` a target and the throughput case fails.
 */

import { useId } from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@/test/render-with-tooltips";
import type { LoadTestMetrics, RunReport } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";
import type { ColorRole } from "@/modules/dashboard/components/charts/uplot/uplotTheme";

interface RecordedProps {
	series: { label: string; role: ColorRole }[];
}

const charts = vi.hoisted(() => new Map<string, unknown>());

// The real module is kept so `BAND_FILL_ALPHA` still resolves for the legend.
vi.mock("@/modules/dashboard/components/charts/uplot/UPlotChart", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/modules/dashboard/components/charts/uplot/UPlotChart")
	>()),
	UPlotChart: (props: unknown) => {
		const id = useId();
		charts.set(id, props);
		return <div data-chart-id={id} />;
	},
}));

const PerformanceTab = (await import("./PerformanceTab")).default;

const THROUGHPUT_TITLE = "Request rate (throughput vs send rate)";
const PERCENTILES_TITLE = "Response time percentiles over time";
const SCATTER_TITLE = /^Response time vs /;

function tick(i: number, withSendRate: boolean): LoadTestMetrics {
	return {
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: 0,
		current_rps: 100 + i * 10,
		current_concurrency: 10 + i * 5,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: 80 + i * 8,
		avg_latency_ms: 25 + i,
		bytes_sent: 0,
		bytes_received: 0,
		...(withSendRate ? { current_send_rate: 105 + i * 10 } : {}),
	};
}

const report = {
	metadata: { runId: "run_1", runType: "load", status: "completed" },
	summary: {
		totalRequests: 500,
		failedRequests: 0,
		requestsPerSecond: 100,
		testDuration: 6,
		errorRate: 0,
	},
	latency: { min: 1, max: 90, avg: 10, p50: 8, p90: 30, p95: 40, p99: 70 },
} as unknown as RunReport;

/** The legend labels of the card titled `title`, with the series of the chart in that card. */
function legendOf(container: HTMLElement, title: string | RegExp) {
	const heading = [...container.querySelectorAll("h3, [data-slot='card-title']")].find((el) =>
		typeof title === "string" ? el.textContent === title : title.test(el.textContent ?? "")
	);
	expect(heading, `no card titled ${String(title)}`).toBeDefined();
	const card = heading?.closest(".surface-card");
	expect(card, `${String(title)} is not in a card`).not.toBeNull();
	const entries = [...(card?.querySelectorAll("[data-legend-role]") ?? [])];
	const chartId = card?.querySelector("[data-chart-id]")?.getAttribute("data-chart-id");
	return {
		labels: entries.map((e) => e.textContent),
		roles: entries.map((e) => e.getAttribute("data-legend-role")),
		chart: charts.get(chartId ?? "") as RecordedProps | undefined,
	};
}

function renderTab(mode: string, withSendRate = true) {
	charts.clear();
	return render(
		<PerformanceTab
			report={report}
			runId="run_1"
			derived={{ mode, targetRps: 0 } as unknown as DashboardDerived}
			timeSeries={Array.from({ length: 6 }, (_, i) => tick(i, withSendRate))}
			monitorSamples={[]}
		/>
	).container;
}

describe("PerformanceTab chart legends (#2697)", () => {
	it("keys the percentile card p50, p95, p99 in the roles its lines are drawn with, then the SLO marker (#2698)", () => {
		const { labels, roles, chart } = legendOf(renderTab("constant_rps"), PERCENTILES_TITLE);

		// The SLO line is a marker, not a series, so the series stay the three percentiles.
		expect(labels).toEqual(["p50", "p95", "p99", "SLO"]);
		expect(chart?.series.map((s) => [s.label, s.role])).toEqual(
			labels.slice(0, 3).map((label, i) => [label, roles[i]])
		);
	});

	it("keys the throughput card with throughput and send rate, and no target or ramp pair", () => {
		const { labels, roles, chart } = legendOf(renderTab("constant_rps"), THROUGHPUT_TITLE);

		expect(labels).toEqual(["throughput", "send rate"]);
		expect(chart?.series.map((s) => [s.label, s.role])).toEqual(
			labels.map((label, i) => [label, roles[i]])
		);
	});

	it("drops the send-rate entry with the line when no tick carries the figure (#2393)", () => {
		const { labels, chart } = legendOf(renderTab("constant_rps", false), THROUGHPUT_TITLE);

		expect(labels).toEqual(["throughput"]);
		expect(chart?.series.map((s) => s.label)).toEqual(["throughput"]);
	});

	it("keys the ramp_up scatter p99 and SLO, and shows no percentile card", () => {
		const container = renderTab("ramp_up");
		const { labels, chart } = legendOf(container, SCATTER_TITLE);

		expect(labels).toEqual(["p99", "SLO"]);
		expect(chart?.series.map((s) => s.label)).toContain("p99");
		expect(container.textContent).not.toContain(PERCENTILES_TITLE);
	});

	it("keeps the throughput key free of the ramp pair on a ramp_up run", () => {
		const { labels } = legendOf(renderTab("ramp_up"), THROUGHPUT_TITLE);

		expect(labels).toEqual(["throughput", "send rate"]);
	});

	it("legends only the cards the live view legends", () => {
		const container = renderTab("constant_rps");
		const legended = [...container.querySelectorAll(".surface-card")].filter((card) =>
			card.querySelector("[data-legend-role]")
		);

		// A render that reached no legend passes every case above vacuously.
		expect(legended.length).toBe(2);
	});
});
