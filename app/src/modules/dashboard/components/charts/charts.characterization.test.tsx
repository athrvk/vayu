/**
 * Characterization snapshots for the time-series charts. These lock the exact
 * SVG output BEFORE the B6 simplify refactor (TimeSeriesChart extraction); the
 * refactor must keep every snapshot byte-identical. Not behavioural tests —
 * their only job is to catch silent rendering drift (tick shifts, dropped
 * live-dot, z-order reorder of the ramp overlay).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ThroughputOverTimeChart } from "./ThroughputOverTimeChart";
import { LatencyOverTimeChart } from "./LatencyOverTimeChart";
import { PercentilesOverTimeChart } from "./PercentilesOverTimeChart";
import type { RampOverlay } from "../../utils/metricsTransforms";

const throughput = [
	{ time: 0.5, rps: 100, sendRate: 110 },
	{ time: 1.0, rps: 250, sendRate: 270 },
	{ time: 1.5, rps: 400, sendRate: 430 },
	{ time: 2.0, rps: 1200, sendRate: 1300 },
];

const latency = [
	{ time: 0.5, latencyMs: 50, wireMs: 40 },
	{ time: 1.0, latencyMs: 80, wireMs: 55 },
	{ time: 1.5, latencyMs: 120, wireMs: 70 },
];

const percentiles = [
	{ time: 0.5, p50: 10, p95: 40, p99: 80 },
	{ time: 1.0, p50: 12, p95: 60, p99: 150 },
	{ time: 1.5, p50: 14, p95: 90, p99: 300 },
];

const rampOverlay: RampOverlay = {
	points: [
		{ configured: 10, achieved: 8 },
		{ configured: 30, achieved: 22 },
		{ configured: 50, achieved: 35 },
	],
	target: 50,
	peakAchieved: 35,
	rampDeviationPct: 24.5,
};

describe("ThroughputOverTimeChart", () => {
	it("completed, with target line", () => {
		const { container } = render(
			<ThroughputOverTimeChart data={throughput} targetRps={500} isCompleted={true} />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("live (animated dot), no target", () => {
		const { container } = render(
			<ThroughputOverTimeChart data={throughput} isCompleted={false} />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("with ramp overlay (z-order: overlay after live dot)", () => {
		const { container } = render(
			<ThroughputOverTimeChart data={throughput} isCompleted={false} rampOverlay={rampOverlay} />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
});

describe("LatencyOverTimeChart", () => {
	it("completed", () => {
		const { container } = render(<LatencyOverTimeChart data={latency} isCompleted={true} />);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("live (animated dot)", () => {
		const { container } = render(<LatencyOverTimeChart data={latency} isCompleted={false} />);
		expect(container.innerHTML).toMatchSnapshot();
	});
});

describe("PercentilesOverTimeChart", () => {
	it("completed", () => {
		const { container } = render(
			<PercentilesOverTimeChart data={percentiles} isCompleted={true} />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
	it("live (animated dot)", () => {
		const { container } = render(
			<PercentilesOverTimeChart data={percentiles} isCompleted={false} />
		);
		expect(container.innerHTML).toMatchSnapshot();
	});
});
