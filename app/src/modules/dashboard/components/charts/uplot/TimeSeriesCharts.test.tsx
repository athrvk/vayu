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
 * Regression coverage for #1717: `RequestRateChart` must decide whether it is
 * drawing a ramp overlay once, from the caller's `rampOverlay` (itself decided
 * by the run's config - load mode + target concurrency - at run start), not
 * from how many buckets of history have accumulated. `UPlotChart` is mocked
 * with a construction counter so the test can tell a shape-preserving
 * re-render (cheap `setData`) apart from a remount (a new chart instance -
 * blanks the canvas and drops cursor/zoom state).
 */

import { useEffect } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import type { RampOverlay } from "../../../utils/metricsTransforms";
import { CONCURRENCY_LABEL, IN_FLIGHT_LABEL } from "@/constants/load-test-modes";
import {
	RequestRateChart,
	ConnectionsChart,
	ErrorRateChart,
	LatencyBreakdownChart,
	LatencyPercentilesChart,
	ServerVitalsChart,
} from "./TimeSeriesCharts";
import { SCATTER_LEGEND } from "./legend";
import type { Marker } from "./plugins";
import type { Breakpoint } from "../../../utils/computeBreakpoint";
import { useClientSettingsStore } from "@/stores";
import { DEFAULT_SLO_THRESHOLD_MS } from "@/constants/client-settings";
import { CustomMetricsChart } from "./CustomMetricsChart";
import { ResponseTimeVsConcurrencyChart } from "./ScatterAndDistribution";

const mockState = vi.hoisted(() => ({
	constructions: 0,
	series: [] as { label: string; bandTo?: number }[],
	markers: [] as Marker[],
	props: {} as {
		yMin?: number | null;
		y2Label?: string;
		data?: (number | null)[][];
		wholeNumberScales?: readonly string[];
	},
}));

// Hoisted above these imports by vitest, so `RequestRateChart` above resolves
// against this mock, not the real `UPlotChart`.
vi.mock("./UPlotChart", () => ({
	UPlotChart: (props: {
		series: { label: string; bandTo?: number }[];
		markers?: Marker[];
		yMin?: number | null;
		y2Label?: string;
		data?: (number | null)[][];
	}) => {
		const { series, markers } = props;
		mockState.props = props;
		mockState.series = series;
		mockState.markers = markers ?? [];
		// A mount-only effect counts constructions, not renders: React keeps the
		// same instance (and skips this effect) across a re-render that reuses
		// the element's key, and creates a new one when the key changes.
		useEffect(() => {
			mockState.constructions++;
		}, []);
		return <div data-testid="uplot-mock" />;
	},
}));

function tick(elapsedSeconds: number): LoadTestMetrics {
	return {
		timestamp: elapsedSeconds * 1000,
		elapsed_seconds: elapsedSeconds,
		requests_completed: elapsedSeconds * 100,
		requests_failed: 0,
		current_rps: 100,
		current_concurrency: 10 + elapsedSeconds,
		latency_p50_ms: 20,
		latency_p95_ms: 40,
		latency_p99_ms: 80,
		avg_latency_ms: 25,
		bytes_sent: 0,
		bytes_received: 0,
		send_rate: 100,
		throughput: 100,
		current_send_rate: 100,
		window_avg_latency_ms: 25,
		window_avg_queue_wait_ms: 0,
	};
}

function historyOf(buckets: number): LoadTestMetrics[] {
	return Array.from({ length: buckets }, (_, i) => tick(i));
}

function rampOverlayOf(points: number): RampOverlay {
	return {
		points: Array.from({ length: points }, (_, i) => ({
			time: i,
			configured: 10 + i,
			achieved: 8 + i,
		})),
		target: 100,
		peakAchieved: 20,
		rampDeviationPct: 5,
	};
}

describe("RequestRateChart - ramp overlay chart identity (#1717)", () => {
	it("constructs UPlotChart once as a ramp-up run's rampOverlay grows from one bucket to three", () => {
		mockState.constructions = 0;

		const { rerender } = render(
			<RequestRateChart history={historyOf(2)} rampOverlay={rampOverlayOf(1)} />
		);
		expect(mockState.constructions).toBe(1);

		// History and the ramp overlay both grow as the run streams in more
		// ticks - the config that decides `hasRamp` (load mode + target) does
		// not change, so the chart must not remount.
		rerender(<RequestRateChart history={historyOf(4)} rampOverlay={rampOverlayOf(3)} />);
		expect(mockState.constructions).toBe(1);
	});

	it("still constructs once for a non-ramp run across the same growth", () => {
		mockState.constructions = 0;

		const { rerender } = render(<RequestRateChart history={historyOf(2)} rampOverlay={null} />);
		expect(mockState.constructions).toBe(1);

		rerender(<RequestRateChart history={historyOf(4)} rampOverlay={null} />);
		expect(mockState.constructions).toBe(1);
	});
});

/** A stored run from before the trailing window: only the run-cumulative rates. */
function withoutSendRate(history: LoadTestMetrics[]): LoadTestMetrics[] {
	return history.map(({ current_send_rate: _dropped, ...rest }) => rest);
}

describe("RequestRateChart - the send-rate line (#2393)", () => {
	it("plots throughput and the per-tick send rate when the ticks carry one", () => {
		render(<RequestRateChart history={historyOf(4)} rampOverlay={null} />);
		expect(mockState.series.map((s) => s.label)).toEqual(["throughput", "send rate"]);
	});

	it("omits the send-rate line for ticks stored without one, leaving the cumulative send_rate unplotted", () => {
		render(<RequestRateChart history={withoutSendRate(historyOf(4))} rampOverlay={null} />);
		expect(mockState.series.map((s) => s.label)).toEqual(["throughput"]);
		// Column 1 is throughput alone; nothing of `send_rate` (100) was added.
		expect(mockState.props.data).toHaveLength(2);
	});

	it("keeps the send-rate line when only some ticks carry the figure, leaving a gap for the rest", () => {
		const mixed = historyOf(4);
		mixed[1] = withoutSendRate([mixed[1]])[0];
		render(<RequestRateChart history={mixed} rampOverlay={null} />);
		expect(mockState.series.map((s) => s.label)).toEqual(["throughput", "send rate"]);
		expect(mockState.props.data?.[2]).toEqual([100, null, 100, 100]);
	});

	it("closes the ramp band on the achieved column whether or not a send-rate column precedes", () => {
		const bandsOf = (history: LoadTestMetrics[]) => {
			render(<RequestRateChart history={history} rampOverlay={rampOverlayOf(3)} />);
			const labels = mockState.series.map((s) => s.label);
			const configured = mockState.series.find((s) => s.label === "configured");
			// Series i is data column i + 1.
			return { target: labels.indexOf("achieved") + 1, actual: configured?.bandTo };
		};
		const withSend = bandsOf(historyOf(4));
		expect(withSend.actual).toBe(withSend.target);
		const without = bandsOf(withoutSendRate(historyOf(4)));
		expect(without.actual).toBe(without.target);
		expect(without.target).toBe(withSend.target - 1);
	});

	it("does not remount as the series grows, send rate or not", () => {
		for (const shape of [(h: LoadTestMetrics[]) => h, withoutSendRate]) {
			mockState.constructions = 0;
			const { rerender, unmount } = render(
				<RequestRateChart history={shape(historyOf(2))} rampOverlay={null} />
			);
			rerender(<RequestRateChart history={shape(historyOf(5))} rampOverlay={null} />);
			expect(mockState.constructions).toBe(1);
			unmount();
		}
	});
});

describe("ConnectionsChart - what the series is called", () => {
	function seriesLabel(mode: string | undefined): string {
		render(<ConnectionsChart mode={mode} history={historyOf(4)} />);
		return mockState.series[0].label;
	}

	it.each(["ramp_up", "capacity", "constant_concurrency", "iterations"])(
		"counts virtual users in the closed-loop %s mode",
		(mode) => {
			expect(seriesLabel(mode)).toBe(CONCURRENCY_LABEL);
		}
	);

	it("counts requests in flight under Constant RPS, which holds no users", () => {
		expect(seriesLabel("constant_rps")).toBe(IN_FLIGHT_LABEL);
	});

	it("reads a run of unknown mode as open-loop, as the dashboard's default branch does", () => {
		expect(seriesLabel(undefined)).toBe(IN_FLIGHT_LABEL);
	});
});

describe("ConnectionsChart - what the series plots (#2821)", () => {
	// An instant of 0 and 10 for users that wait in step; their mean is steady.
	const aliased = (elapsed: number, mean?: number | null): LoadTestMetrics => {
		const t = tick(elapsed);
		t.current_concurrency = elapsed % 2 === 0 ? 0 : 10;
		if (mean !== undefined) t.window_avg_in_flight = mean;
		return t;
	};

	it("plots the window's mean in flight, not the instant that aliases", () => {
		const history = [0, 1, 2, 3].map((i) => aliased(i, 4.2));
		render(<ConnectionsChart mode="constant_concurrency" history={history} />);
		expect(mockState.props.data?.[1]).toEqual([4.2, 4.2, 4.2, 4.2]);
	});

	it("keeps an idle window's measured 0 rather than falling back to the instant", () => {
		const history = [0, 1, 2, 3].map((i) => aliased(i + 1, 0));
		render(<ConnectionsChart mode="constant_concurrency" history={history} />);
		expect(mockState.props.data?.[1]).toEqual([0, 0, 0, 0]);
	});

	it.each([
		["a tick stored before the mean existed", undefined],
		["a live frame whose mean is null", null],
	])("falls back to the instant for %s", (_name, mean) => {
		const history = [0, 1, 2, 3].map((i) => aliased(i, mean));
		render(<ConnectionsChart mode="constant_concurrency" history={history} />);
		expect(mockState.props.data?.[1]).toEqual([0, 10, 0, 10]);
	});
});

describe("ConnectionsChart - modes that stay on the instant (#2821)", () => {
	it.each(["ramp_up", "capacity", "constant_rps"])("plots %s's instantaneous count", (mode) => {
		const history = [0, 1, 2, 3].map((i) => {
			const t = tick(i);
			t.current_concurrency = i % 2 === 0 ? 0 : 10;
			t.window_avg_in_flight = 4.2;
			return t;
		});
		render(<ConnectionsChart mode={mode} history={history} />);
		expect(mockState.props.data?.[1]).toEqual([0, 10, 0, 10]);
	});
});

describe("LatencyBreakdownChart - what the series are called", () => {
	it("names the average latency as including queue wait, and the other series wire time", () => {
		render(<LatencyBreakdownChart history={historyOf(4)} />);
		expect(mockState.series.map((s) => s.label)).toEqual([
			"average latency (incl. queue wait)",
			"wire time",
		]);
	});
});

describe("ResponseTimeVsConcurrencyChart - the SLO line (#2816, #2939)", () => {
	afterEach(() => useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS }));
	const horizontals = () => mockState.markers.filter((m) => m.orient === "horizontal");
	const NOT_CROSSED: Breakpoint = {
		crossed: false,
		concurrency: null,
		timeSeconds: null,
		p99Ms: null,
		sloMs: 200,
		sloSource: "run",
		atRunStart: false,
	};

	it("draws the SLO it is handed, not the breakpoint's or the setting's", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 450 });
		render(
			<ResponseTimeVsConcurrencyChart
				history={historyOf(4)}
				breakpoint={NOT_CROSSED}
				sloMs={50}
			/>
		);
		expect(horizontals().map((m) => [m.value, m.label])).toEqual([[50, "SLO 50ms"]]);
	});

	it("draws no horizontal line when handed none, whatever the setting or breakpoint holds", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 450 });
		render(<ResponseTimeVsConcurrencyChart history={historyOf(4)} breakpoint={NOT_CROSSED} />);
		expect(horizontals()).toEqual([]);
	});
});

describe("ResponseTimeVsConcurrencyChart - breakpoint marker", () => {
	it("names the breakpoint in virtual users", () => {
		render(
			<ResponseTimeVsConcurrencyChart
				history={historyOf(4)}
				breakpoint={{
					crossed: true,
					concurrency: 45,
					timeSeconds: 2,
					p99Ms: 227,
					sloMs: 200,
					sloSource: "run",
					atRunStart: false,
				}}
			/>
		);
		expect(mockState.markers.map((m) => m.label)).toContain("~45 virtual users");
	});
});

describe("ResponseTimeVsConcurrencyChart - knee marker (#2931)", () => {
	const verticals = () => mockState.markers.filter((m) => m.orient === "vertical");

	it("draws a destructive vertical line at the knee, apart from the breakpoint's", () => {
		render(
			<ResponseTimeVsConcurrencyChart
				history={historyOf(4)}
				kneeConcurrency={64}
				breakpoint={{
					crossed: true,
					concurrency: 45,
					timeSeconds: 2,
					p99Ms: 227,
					sloMs: 200,
					sloSource: "run",
					atRunStart: false,
				}}
			/>
		);
		expect(verticals().map((m) => [m.value, m.label, m.role])).toEqual([
			[45, "~45 virtual users", "warning"],
			[64, "knee 64 virtual users", "destructive"],
		]);
	});

	it("reads a knee of one in the singular", () => {
		render(<ResponseTimeVsConcurrencyChart history={historyOf(4)} kneeConcurrency={1} />);
		expect(verticals().map((m) => m.label)).toEqual(["knee 1 virtual user"]);
	});

	it("draws no line when no knee is given", () => {
		render(<ResponseTimeVsConcurrencyChart history={historyOf(4)} />);
		expect(verticals()).toEqual([]);
	});
});

describe("RequestRateChart - what the secondary axis measures", () => {
	it("names the ramp overlay's axis for the virtual users it counts", () => {
		render(
			<RequestRateChart
				history={historyOf(4)}
				rampOverlay={rampOverlayOf(3)}
				mode="ramp_up"
			/>
		);
		expect(mockState.props.y2Label).toBe(CONCURRENCY_LABEL);
	});

	it("leaves a run with no overlay without a label, as it has no secondary axis", () => {
		render(<RequestRateChart history={historyOf(4)} rampOverlay={null} mode="ramp_up" />);
		expect(mockState.props.y2Label).toBeUndefined();
	});
});

describe("which axes tick on whole numbers (#2858)", () => {
	it("opts the concurrency chart's value axis in", () => {
		render(<ConnectionsChart mode="ramp_up" history={historyOf(4)} />);
		expect(mockState.props.wholeNumberScales).toEqual(["y"]);
	});

	it("opts the throughput chart's concurrency axis in, and not its rate axis", () => {
		render(<RequestRateChart history={historyOf(4)} rampOverlay={rampOverlayOf(3)} />);
		expect(mockState.props.wholeNumberScales).toEqual(["y2"]);
	});

	it("leaves a chart that does not count things on the primitive's default", () => {
		render(<ErrorRateChart history={historyOf(4)} />);
		expect("wholeNumberScales" in mockState.props).toBe(false);
	});
});

describe("charts' y base", () => {
	const samples = [
		{ timestamp: 0, series: { cpu: -3 } },
		{ timestamp: 2000, series: { cpu: 4 } },
	];

	it("leaves the base at the primitive's zero default for a metric with a natural floor", () => {
		render(<LatencyPercentilesChart history={historyOf(4)} />);
		expect("yMin" in mockState.props).toBe(false);
	});

	it("opts server vitals out, which are in the target's own units and may be negative", () => {
		render(<ServerVitalsChart history={historyOf(4)} samples={samples} />);
		expect(mockState.props.yMin).toBeNull();
	});

	it("opts custom metrics out, which are in a script's own units and may be negative", () => {
		const history = historyOf(4).map((t) => ({
			...t,
			custom_metrics: { delta: { type: "counter" as const, count: 1, value: -1 } },
		}));
		render(<CustomMetricsChart history={history} />);
		expect(mockState.props.yMin).toBeNull();
	});
});

describe("the breakpoint line on the time charts (#2698)", () => {
	const CROSSED: Breakpoint = {
		crossed: true,
		concurrency: 12,
		timeSeconds: 2,
		p99Ms: 303,
		sloMs: 200,
		sloSource: "run",
		atRunStart: false,
	};

	/** The charts that take a breakpoint, each rendered with the same crossed run. */
	const CHARTS = {
		percentiles: (mode: string | undefined, breakpoint: Breakpoint | null) => (
			<LatencyPercentilesChart history={historyOf(4)} mode={mode} breakpoint={breakpoint} />
		),
		rate: (mode: string | undefined, breakpoint: Breakpoint | null) => (
			<RequestRateChart history={historyOf(4)} mode={mode} breakpoint={breakpoint} />
		),
		concurrency: (mode: string | undefined, breakpoint: Breakpoint | null) => (
			<ConnectionsChart history={historyOf(4)} mode={mode} breakpoint={breakpoint} />
		),
		errors: (mode: string | undefined, breakpoint: Breakpoint | null) => (
			<ErrorRateChart history={historyOf(4)} mode={mode} breakpoint={breakpoint} />
		),
	};
	type ChartName = keyof typeof CHARTS;
	const ALL = Object.keys(CHARTS) as ChartName[];

	function verticalMarkers(
		chart: ChartName,
		mode: string | undefined,
		breakpoint: Breakpoint | null = CROSSED
	): Marker[] {
		const { unmount } = render(CHARTS[chart](mode, breakpoint));
		const found = mockState.markers.filter((m) => m.orient === "vertical");
		unmount();
		return found;
	}

	it("names the SLO crossed and keeps the observed p99 out of the label", () => {
		const [marker] = verticalMarkers("percentiles", "ramp_up");
		expect(marker.label).toBe("p99 > SLO 200ms");
		expect(marker.label).not.toContain("303");
	});

	it("names a Settings-judged line the threshold in Settings, never an SLO the run did not use (#2939)", () => {
		const [marker] = verticalMarkers("percentiles", "ramp_up", {
			...CROSSED,
			sloSource: "settings",
		});
		expect(marker.label).toBe("p99 > 200ms threshold in Settings");
		expect(marker.label).not.toContain("SLO");
	});

	it("leaves the SLO's number out of the label when none was in play", () => {
		const [marker] = verticalMarkers("percentiles", "ramp_up", { ...CROSSED, sloMs: null });
		expect(marker.label).toBe("p99 > SLO");
	});

	it("puts the observed p99 and the load at the crossing in the hover", () => {
		const [marker] = verticalMarkers("percentiles", "ramp_up");
		expect(marker.hover).toBe("p99 303ms at 12 virtual users");
	});

	it("counts requests in flight, not users, where the mode holds no users", () => {
		const hover = (concurrency: number) =>
			verticalMarkers("percentiles", "constant_rps", { ...CROSSED, concurrency })[0].hover;
		expect(hover(12)).toBe("p99 303ms at 12 requests in flight");
		expect(hover(1)).toBe("p99 303ms at 1 request in flight");
	});

	it("drops the hover's load clause when the crossing recorded none", () => {
		const [marker] = verticalMarkers("percentiles", "ramp_up", {
			...CROSSED,
			concurrency: null,
		});
		expect(marker.hover).toBe("p99 303ms");
	});

	it.each(ALL)("draws the line on the %s chart of a ramp_up run", (chart) => {
		expect(verticalMarkers(chart, "ramp_up")).toHaveLength(1);
	});

	// A capacity run's percentile card is the scatter, so its crossing time shows
	// on every time chart, as a ramp's does (#2931).
	it.each(ALL)("draws the line on the %s chart of a capacity run", (chart) => {
		expect(verticalMarkers(chart, "capacity")).toHaveLength(1);
	});

	it.each(["constant_concurrency", "constant_rps", "iterations", undefined])(
		"draws it on the percentile chart alone in mode %s",
		(mode) => {
			expect(verticalMarkers("percentiles", mode)).toHaveLength(1);
			for (const chart of ALL.filter((c) => c !== "percentiles")) {
				expect(verticalMarkers(chart, mode), chart).toEqual([]);
			}
		}
	);

	it.each(ALL)(
		"draws no line on the %s chart when the first reading was already over",
		(chart) => {
			expect(verticalMarkers(chart, "ramp_up", { ...CROSSED, atRunStart: true })).toEqual([]);
			expect(
				verticalMarkers(chart, "constant_rps", { ...CROSSED, atRunStart: true })
			).toEqual([]);
		}
	);

	it("draws no line for a run that never crossed", () => {
		const notCrossed: Breakpoint = {
			...CROSSED,
			crossed: false,
			concurrency: null,
			timeSeconds: null,
			p99Ms: null,
		};
		expect(verticalMarkers("percentiles", "ramp_up", notCrossed)).toEqual([]);
	});
});

describe("LatencyPercentilesChart - the SLO line (#2698, #2939)", () => {
	afterEach(() => useClientSettingsStore.setState({ sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS }));
	const horizontals = () => mockState.markers.filter((m) => m.orient === "horizontal");

	it("draws the SLO it is handed, named as the scatter names it", () => {
		render(
			<LatencyPercentilesChart
				history={historyOf(4)}
				mode="constant_concurrency"
				sloMs={350}
			/>
		);
		expect(horizontals()).toEqual([
			{ orient: "horizontal", value: 350, label: "SLO 350ms", role: SCATTER_LEGEND.slo.role },
		]);
	});

	it("draws no horizontal line when handed none, whatever the setting or breakpoint holds", () => {
		useClientSettingsStore.setState({ sloThresholdMs: 450 });
		render(
			<LatencyPercentilesChart
				history={historyOf(4)}
				mode="ramp_up"
				breakpoint={{
					crossed: false,
					concurrency: null,
					timeSeconds: null,
					p99Ms: null,
					sloMs: 450,
					sloSource: "run",
					atRunStart: false,
				}}
			/>
		);
		expect(horizontals()).toEqual([]);
	});

	it("draws it for a run that began over it, beside no vertical line", () => {
		render(
			<LatencyPercentilesChart
				history={historyOf(4)}
				mode="ramp_up"
				sloMs={200}
				breakpoint={{
					crossed: true,
					concurrency: 10,
					timeSeconds: 0,
					p99Ms: 400,
					sloMs: 200,
					sloSource: "run",
					atRunStart: true,
				}}
			/>
		);
		expect(mockState.markers.map((m) => [m.orient, m.label])).toEqual([
			["horizontal", "SLO 200ms"],
		]);
	});

	it("plots the three percentiles only, the SLO being a line and not a series", () => {
		render(<LatencyPercentilesChart history={historyOf(4)} />);
		expect(mockState.series.map((s) => s.label)).toEqual(["p50", "p95", "p99"]);
	});
});
