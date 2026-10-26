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
import { useClientSettingsStore, useDashboardStore } from "@/stores";
import type { LoadTestRunConfig } from "@/stores/dashboard-store";
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
		current_send_rate: 105 + i * 10,
		window_avg_latency_ms: 25 + i,
		window_avg_queue_wait_ms: i * 0.5,
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
// capacity draws the scatter and no ramp pair, its search sets no ramp.
const RUNS: MetricsViewProps[] = [
	base,
	{ ...base, mode: "constant_rps", rampConfig: undefined },
	{ ...base, mode: "capacity", rampConfig: undefined },
];

interface LegendEntryView {
	card: Element;
	label: string;
	role: ColorRole;
	swatch: HTMLElement;
	chart: RecordedProps;
}

/** The run's own p99 budget, which is what the live view draws as its SLO (#2939). */
const WITH_SLO: LoadTestRunConfig = { latencyP99Ms: 200 };

/**
 * Every legend entry in the live view, paired with the props of the chart in
 * its card, for a run started with `config`.
 */
function legendEntries(
	props: MetricsViewProps,
	config: LoadTestRunConfig = WITH_SLO
): LegendEntryView[] {
	charts.clear();
	useDashboardStore.getState().startRun("r", config);
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
		all = RUNS.flatMap((run) => legendEntries(run));
	});

	it("finds the legends it is meant to be guarding", () => {
		// A render that reached no legend passes the loops below having checked nothing.
		expect(all.length).toBeGreaterThanOrEqual(8);
		const labels = new Set(all.map((e) => e.label));
		for (const expected of [
			"throughput",
			"send rate",
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

/** The same run with every tick stored before the trailing window existed: no per-tick send rate. */
function withoutSendRate(props: MetricsViewProps): MetricsViewProps {
	return {
		...props,
		historicalMetrics: props.historicalMetrics.map(
			({ current_send_rate: _dropped, ...rest }) => rest
		),
	};
}

describe("MetricsView send-rate legend follows the series (#2393)", () => {
	// The send-rate line is conditional on the ticks, so its legend entry is too:
	// a swatch for a line the chart never drew is the defect this pins.
	const throughputCard = (entries: LegendEntryView[]) =>
		entries.filter((e) => e.chart.series.some((s) => s.label === "throughput"));

	it("lists send rate and draws it when the ticks carry the figure", () => {
		const entries = throughputCard(legendEntries(RUNS[1]));
		expect(entries.map((e) => e.label)).toContain("send rate");
		expect(entries[0].chart.series.map((s) => s.label)).toContain("send rate");
	});

	it("lists neither, together, when no tick carries it", () => {
		const entries = throughputCard(legendEntries(withoutSendRate(RUNS[1])));
		// The card still legends throughput: an empty list proves nothing.
		expect(entries.map((e) => e.label)).toContain("throughput");
		expect(entries.map((e) => e.label)).not.toContain("send rate");
		expect(entries[0].chart.series.map((s) => s.label)).not.toContain("send rate");
	});
});

describe("MetricsView percentile legend names the SLO line (#2698)", () => {
	it("lists SLO beside the percentiles, over a chart that draws that line", () => {
		const entries = legendEntries(RUNS[1]).filter((e) =>
			e.chart.series.some((s) => s.label === "p99")
		);
		expect(entries.map((e) => e.label)).toEqual(["p50", "p95", "p99", "SLO"]);
		const slo = entries.find((e) => e.label === "SLO");
		expect(isDrawnWithRole(slo as LegendEntryView, "other")).toBe(true);
		// The line is a marker; the chart's series stay the three percentiles.
		expect(entries[0].chart.series.map((s) => s.label)).toEqual(["p50", "p95", "p99"]);
	});
});

describe("MetricsView draws no SLO for a run that declared none (#2939)", () => {
	// The Settings threshold is a client preference; a run with no p99 line must not
	// borrow it, as its stored report does not.
	beforeAll(() => {
		useClientSettingsStore.setState({ sloThresholdMs: 250 });
	});

	it.each(["ramp_up", "constant_rps"] as const)(
		"lists no SLO and draws no line in mode %s",
		(mode) => {
			const entries = legendEntries({ ...base, mode, rampConfig: undefined }, {});
			const p99Card = entries.filter((e) => e.chart.series.some((s) => s.label === "p99"));
			expect(p99Card.map((e) => e.label)).not.toContain("SLO");
			expect(p99Card.length).toBeGreaterThan(0);
			const markers = p99Card[0].chart.markers?.map((m) => m.label) ?? [];
			expect(markers.some((label) => label.startsWith("SLO"))).toBe(false);
		}
	);
});

describe("MetricsView draws the scatter for a capacity run (#2931)", () => {
	const SCATTER_LABELS = ["p99", "SLO"];
	const PERCENTILE_LABELS = ["p50", "p95", "p99", "SLO"];

	/** The legend labels of every card whose chart draws a p99 series, one list per card. */
	function p99Cards(props: MetricsViewProps): string[][] {
		const entries = legendEntries(props, WITH_SLO).filter((e) =>
			e.chart.series.some((s) => s.label === "p99")
		);
		return [...new Set(entries.map((e) => e.card))].map((card) =>
			entries.filter((e) => e.card === card).map((e) => e.label)
		);
	}

	it.each(["ramp_up", "capacity"] as const)(
		"draws the scatter and no percentile card in mode %s",
		(mode) => {
			expect(p99Cards({ ...base, mode, rampConfig: undefined })).toEqual([SCATTER_LABELS]);
		}
	);

	it.each(["constant_rps", "constant_concurrency", "iterations"] as const)(
		"keeps the percentile card, and no scatter, in mode %s",
		(mode) => {
			expect(p99Cards({ ...base, mode, rampConfig: undefined })).toEqual([PERCENTILE_LABELS]);
		}
	);

	it("draws the SLO line and no knee marker on the live capacity scatter", () => {
		// The knee is in the final report only; a live run has nothing to draw it from.
		charts.clear();
		useDashboardStore.getState().startRun("r", { mode: "capacity", sloMs: 50 });
		render(
			<TooltipProvider>
				<MetricsView {...base} mode="capacity" rampConfig={undefined} />
			</TooltipProvider>
		);
		const scatter = [...charts.values()].find((props) =>
			(props as RecordedProps).series.some(
				(s) => s.label === "p99" && s.role === "categorical"
			)
		) as RecordedProps;
		const labels = scatter.markers?.map((m) => m.label) ?? [];
		expect(labels).toContain("SLO 50ms");
		expect(labels.some((label) => label.startsWith("knee"))).toBe(false);
	});
});

describe("MetricsView status card's receive rate picks its unit (#2860)", () => {
	/** The legend's rate when the last two ticks are `dBytes` apart over `dtSeconds`. */
	function receiveRate(dBytes: number, dtSeconds: number): string | null {
		const history = Array.from({ length: 6 }, (_, i) => tick(i));
		const before = history[4];
		history[5] = {
			...history[5],
			elapsed_seconds: before.elapsed_seconds + dtSeconds,
			bytes_received: before.bytes_received + dBytes,
		};
		const { container, unmount } = render(
			<TooltipProvider>
				<MetricsView {...base} historicalMetrics={history} />
			</TooltipProvider>
		);
		// The unit's own span; its parent holds the figure in front of it.
		const unit = [...container.querySelectorAll("span")].find((el) =>
			/^ \S+\/s in$/.test(el.textContent ?? "")
		);
		const text = unit?.parentElement?.textContent ?? null;
		unmount();
		return text;
	}

	// Two 100 ms tick pairs of one steady rate, which MB/s printed as "0" and "0.01".
	it("reads KB/s below 0.1 MB/s, on both sides of the old 0 / 0.01 flip", () => {
		expect(receiveRate(440, 0.1)).toBe("4.4 KB/s in");
		expect(receiveRate(530, 0.1)).toBe("5.3 KB/s in");
	});

	it("reads MB/s from 0.1 MB/s", () => {
		expect(receiveRate(2_500_000, 1)).toBe("2.5 MB/s in");
	});
});
