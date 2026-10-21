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
 * What the percentile chart is handed for a live run (issue #2385): one point
 * per gate frame, none for the frames between, and at a bucket wider than a
 * second the worst second in the bucket rather than the last. `UPlotChart` is
 * mocked to capture the aligned data it receives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import { useClientSettingsStore } from "@/stores";

const captured = vi.hoisted(() => ({ data: [] as (number | null)[][] }));

vi.mock("./UPlotChart", () => ({
	UPlotChart: (props: { data: (number | null)[][] }) => {
		captured.data = props.data;
		return <div data-testid="uplot-mock" />;
	},
}));

const { LatencyPercentilesChart } = await import("./TimeSeriesCharts");

function frame(partial: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		// The window every frame carries: never what this chart may plot.
		latency_p50_ms: 777,
		latency_p95_ms: 777,
		latency_p99_ms: 777,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		live: true,
		...partial,
	};
}

const gate = (elapsed: number, p99: number): LoadTestMetrics =>
	frame({
		elapsed_seconds: elapsed,
		second_samples: 500,
		second_p50_ms: p99 / 10,
		second_p95_ms: p99 / 2,
		second_p99_ms: p99,
	});

/** Ten frames a second, a gate on each whole second; the stall is the first second's. */
function liveRun(seconds: number, gateP99: (second: number) => number): LoadTestMetrics[] {
	const out: LoadTestMetrics[] = [];
	for (let tenth = 1; tenth <= seconds * 10; tenth++) {
		const elapsed = tenth / 10;
		out.push(
			tenth % 10 === 0 ? gate(elapsed, gateP99(elapsed)) : frame({ elapsed_seconds: elapsed })
		);
	}
	return out;
}

describe("LatencyPercentilesChart on a live series", () => {
	beforeEach(() => {
		captured.data = [];
		useClientSettingsStore.setState({ chartBucketSeconds: 0.5 });
	});

	it("plots a point per second and none of the 100 ms windows", () => {
		render(<LatencyPercentilesChart history={liveRun(5, (s) => 10 * s)} />);
		const [times, , , p99] = captured.data;
		expect(times).toEqual([1, 2, 3, 4, 5]);
		expect(p99).toEqual([10, 20, 30, 40, 50]);
		expect(p99).not.toContain(777);
	});

	it("shows the worst second of a wide bucket, not the last", () => {
		useClientSettingsStore.setState({ chartBucketSeconds: 5 });
		// Seconds 3..7 share the 5 s bucket; the stall is second 4, not the last.
		render(<LatencyPercentilesChart history={liveRun(7, (s) => (s === 4 ? 900 : 40))} />);
		const [times, p50, p95, p99] = captured.data;
		expect(times).toEqual([0, 5]);
		expect(p99[1]).toBe(900);
		expect(p95[1]).toBe(450);
		expect(p50[1]).toBe(90);
	});

	it("hands the chart a null for a second that completed nothing (#2386)", () => {
		const history = liveRun(5, (s) => 10 * s).map((m) =>
			m.elapsed_seconds === 3
				? {
						...m,
						second_samples: 0,
						second_p50_ms: null,
						second_p95_ms: null,
						second_p99_ms: null,
					}
				: m
		);
		render(<LatencyPercentilesChart history={history} />);
		const [times, p50, p95, p99] = captured.data;
		// A null, not a skipped x: uPlot joins the neighbours of a missing x.
		expect(times).toEqual([1, 2, 3, 4, 5]);
		expect(p99).toEqual([10, 20, null, 40, 50]);
		expect(p95[2]).toBeNull();
		expect(p50[2]).toBeNull();
	});
});
