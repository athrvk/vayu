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
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import type { RampOverlay } from "../../../utils/metricsTransforms";
import { CONCURRENCY_LABEL, IN_FLIGHT_LABEL } from "@/constants/load-test-modes";
import {
	RequestRateChart,
	ConnectionsChart,
	LatencyBreakdownChart,
	LatencyPercentilesChart,
	ServerVitalsChart,
} from "./TimeSeriesCharts";
import { CustomMetricsChart } from "./CustomMetricsChart";
import { ResponseTimeVsConcurrencyChart } from "./ScatterAndDistribution";

const mockState = vi.hoisted(() => ({
	constructions: 0,
	series: [] as { label: string }[],
	markers: [] as { label: string }[],
	props: {} as { yMin?: number | null; y2Label?: string },
}));

// Hoisted above these imports by vitest, so `RequestRateChart` above resolves
// against this mock, not the real `UPlotChart`.
vi.mock("./UPlotChart", () => ({
	UPlotChart: (props: {
		series: { label: string }[];
		markers?: { label: string }[];
		yMin?: number | null;
		y2Label?: string;
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

describe("LatencyBreakdownChart - what the series are called", () => {
	it("names the average latency as including queue wait, and the other series wire time", () => {
		render(<LatencyBreakdownChart history={historyOf(4)} />);
		expect(mockState.series.map((s) => s.label)).toEqual([
			"average latency (incl. queue wait)",
			"wire time",
		]);
	});
});

describe("ResponseTimeVsConcurrencyChart - breakpoint marker", () => {
	it("names the breakpoint in virtual users", () => {
		render(
			<ResponseTimeVsConcurrencyChart
				history={historyOf(4)}
				breakpoint={{ crossed: true, concurrency: 45, timeSeconds: 2, p99Ms: 227 }}
			/>
		);
		expect(mockState.markers.map((m) => m.label)).toContain("~45 virtual users");
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
