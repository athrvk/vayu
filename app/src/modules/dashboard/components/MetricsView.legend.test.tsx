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
 * Issue #2311: the cards' legends were hand-written `hsl(var(--x))` swatches and
 * nine of the thirteen disagreed with the role their series is drawn with (the
 * throughput line keyed as `--primary` while the series is `categorical`, p95
 * as `--warning` while the series is `categorical-2`, and so on). A legend is
 * now `ChartLegend`, built from the roles tables the chart modules draw from.
 *
 * This renders the live view with `UPlotChart` swapped for a recorder, then
 * reads each card's legend against the series and markers that card's chart
 * was handed. A role changed on one side only, or a swatch painted from
 * anything but `ROLE_TOKEN`, fails here.
 */

import { useId } from "react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoadTestMetrics } from "@/types";
import type { DisplayMetrics, MetricsViewProps } from "../types";
import MetricsView from "./MetricsView";
import { ROLE_TOKEN, type ColorRole } from "./charts/uplot/uplotTheme";
import { BAND_FILL_ALPHA } from "./charts/uplot/UPlotChart";

interface RecordedProps {
	series: { label: string; role: ColorRole; bandTo?: number; bandRole?: ColorRole }[];
	markers?: { label: string; role: ColorRole }[];
}

const charts = vi.hoisted(() => new Map<string, unknown>());

// The real module is kept so `BAND_FILL_ALPHA` still resolves for the legend.
vi.mock("./charts/uplot/UPlotChart", async (importOriginal) => ({
	...(await importOriginal<typeof import("./charts/uplot/UPlotChart")>()),
	UPlotChart: (props: unknown) => {
		const id = useId();
		charts.set(id, props);
		return <div data-chart-id={id} />;
	},
}));

function tick(i: number): LoadTestMetrics {
	return {
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: i * 2,
		current_rps: 100 + i * 10,
		current_concurrency: 10 + i * 5,
		latency_p50_ms: 20 + i,
		latency_p95_ms: 40 + i * 3,
		latency_p99_ms: 80 + i * 8,
		avg_latency_ms: 25 + i,
		avg_queue_wait_ms: i * 0.5,
		bytes_sent: i * 1000,
		bytes_received: i * 5000,
		status_codes: { "200": i * 90, "500": i * 3 },
	};
}

const base: MetricsViewProps = {
	metrics: {
		requests_completed: 500,
		requests_failed: 4,
		current_rps: 120,
		latency_p50_ms: 22,
		latency_p95_ms: 48,
		latency_p99_ms: 96,
		avg_latency_ms: 27,
		bytes_sent: 5000,
		bytes_received: 25000,
	} as DisplayMetrics,
	historicalMetrics: Array.from({ length: 6 }, (_, i) => tick(i)),
	mode: "ramp_up",
	targetRps: 500,
	rampConfig: { rampUpDurationSeconds: 10, startConcurrency: 1, targetConcurrency: 100 },
};

// ramp_up draws the scatter and the ramp pair; constant_rps draws the percentile card.
const RUNS: MetricsViewProps[] = [base, { ...base, mode: "constant_rps", rampConfig: undefined }];

interface LegendEntryView {
	card: Element;
	label: string;
	role: ColorRole;
	swatch: HTMLElement;
	chart: RecordedProps;
}

/** Every legend entry in the live view, paired with the props of the chart in its card. */
function legendEntries(props: MetricsViewProps): LegendEntryView[] {
	charts.clear();
	const { container } = render(
		<TooltipProvider>
			<MetricsView {...props} />
		</TooltipProvider>
	);
	const found: LegendEntryView[] = [];
	for (const card of container.querySelectorAll(".surface-card")) {
		const entries = [...card.querySelectorAll("[data-legend-role]")];
		if (entries.length === 0) continue;
		const chartId = card.querySelector("[data-chart-id]")?.getAttribute("data-chart-id");
		const chart = chartId ? (charts.get(chartId) as RecordedProps | undefined) : undefined;
		expect(chart, `no chart in the card legended ${entries.length} entries`).toBeDefined();
		for (const entry of entries) {
			found.push({
				card,
				label: entry.textContent ?? "",
				role: entry.getAttribute("data-legend-role") as ColorRole,
				swatch: entry.firstElementChild as HTMLElement,
				chart: chart as RecordedProps,
			});
		}
	}
	return found;
}

/**
 * A line or dot is named by a series label; the SLO and target lines are
 * markers, whose label carries the value after the legend's name ("SLO 200ms");
 * a band is the fill of the series that declares it.
 */
function isDrawnWithRole({ chart, label, role }: LegendEntryView, shape: "band" | "other") {
	if (shape === "band") return chart.series.some((s) => s.bandTo != null && s.bandRole === role);
	const named = [...chart.series, ...(chart.markers ?? [])];
	return named.some(
		(item) => (item.label === label || item.label.startsWith(`${label} `)) && item.role === role
	);
}

describe("MetricsView legends match the roles their charts draw", () => {
	let all: LegendEntryView[] = [];
	beforeAll(() => {
		all = RUNS.flatMap(legendEntries);
	});

	it("finds the legends it is meant to be guarding", () => {
		// A render that reached no legend passes the loops below having checked nothing.
		expect(all.length).toBeGreaterThanOrEqual(8);
		const labels = new Set(all.map((e) => e.label));
		for (const expected of [
			"throughput",
			"achieved",
			"queue wait",
			"p99",
			"SLO",
			"p50",
			"p95",
		]) {
			expect(labels, `${expected} was never rendered in a legend`).toContain(expected);
		}
	});

	it("gives every entry a series, marker or band of the same name and role", () => {
		for (const entry of all) {
			const shape = entry.swatch.className.includes("rounded-sm") ? "band" : "other";
			expect(
				isDrawnWithRole(entry, shape),
				`${entry.label}: legend says ${entry.role}, chart draws ${JSON.stringify([
					...entry.chart.series,
					...(entry.chart.markers ?? []),
				])}`
			).toBe(true);
		}
	});

	it("paints every swatch from the token its role resolves to", () => {
		for (const { label, role, swatch } of all) {
			const token = `var(${ROLE_TOKEN[role]})`;
			const band = swatch.className.includes("rounded-sm");
			expect(swatch.style.background, label).toBe(
				band ? `hsl(${token} / ${BAND_FILL_ALPHA})` : `hsl(${token})`
			);
		}
	});
});
