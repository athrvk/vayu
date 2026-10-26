/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * The request-across-runs trend (#2165): p95, throughput and error rate, one
 * point per run, from the runs list alone.
 *
 * `UPlotChart` is stubbed to record its props, so the wrappers' real data and
 * annotation shaping runs and the assertions read what a canvas would be handed.
 * Mutation check: drop the newest run in `buildRunTrend` (`.slice(1)` after the
 * sort) and the point-count and stopped-run cases go red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { apiService } from "@/services/api";
import type { Run } from "@/types";

interface ChartProps {
	data: [number[], (number | null)[], (number | null)[]];
	series: { label: string; role: string }[];
	annotations: { startSeconds: number }[];
	markers: { value: number; label: string }[];
	xTooltipFormat: (v: number) => string;
}

const charts: ChartProps[] = [];

vi.mock("@/modules/dashboard/components/charts/uplot/UPlotChart", () => ({
	UPlotChart: (props: ChartProps) => {
		charts.push(props);
		return <div data-testid="uplot" />;
	},
}));

vi.mock("@/services/api", () => ({
	apiService: { listRuns: vi.fn() },
}));

const RunTrend = (await import("./RunTrend")).default;
const mocked = vi.mocked(apiService);

type Summary = NonNullable<Extract<Run, { type: "load" }>["resultSummary"]>;

function loadRun(n: number, summary: Summary | undefined, status: Run["status"] = "completed") {
	return {
		id: `run-${n}`,
		type: "load",
		status,
		startTime: n * 60_000,
		endTime: n * 60_000 + 1,
		requestId: "req-1",
		resultSummary: summary,
	} as Run;
}

/** `n` runs, newest first as the engine lists them, each with all three figures. */
function runs(n: number): Run[] {
	return Array.from({ length: n }, (_, i) => n - i).map((k) =>
		loadRun(k, { rps: k * 10, p95Ms: k * 100, errorRate: k })
	);
}

function answerWith(list: Run[]) {
	mocked.listRuns.mockResolvedValue({
		data: list,
		pagination: {
			total: list.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: list.length,
			nextBefore: null,
		},
	});
}

function renderTrend(requestId: string | null = "req-1", openRunId = "run-2") {
	return render(withQueryClient(<RunTrend requestId={requestId} openRunId={openRunId} />));
}

beforeEach(() => {
	charts.length = 0;
	mocked.listRuns.mockReset();
});

describe("RunTrend", () => {
	it("draws a point per run in each of the three series", async () => {
		answerWith(runs(5));
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		for (const chart of charts) {
			const [xs, line, dots] = chart.data;
			expect(xs).toEqual([1, 2, 3, 4, 5]);
			expect(line).toHaveLength(5);
			expect(dots).toEqual(line);
		}
		expect(charts.map((c) => c.series[0].label)).toEqual([
			"p95 latency",
			"throughput",
			"error rate",
		]);
		// Oldest first, so the newest run is the right-hand point.
		expect(charts[0].data[1]).toEqual([100, 200, 300, 400, 500]);
		expect(charts[1].data[1]).toEqual([10, 20, 30, 40, 50]);
		expect(charts[2].data[1]).toEqual([1, 2, 3, 4, 5]);
	});

	it("asks for the request's runs and nothing per run", async () => {
		answerWith(runs(3));
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		expect(mocked.listRuns).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req-1", type: "load" })
		);
	});

	it("draws nothing for a request with a single run", async () => {
		answerWith(runs(1));
		const { container } = renderTrend();

		await waitFor(() => expect(mocked.listRuns).toHaveBeenCalled());
		// Let the resolved list reach the component before asserting it drew nothing.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
		expect(charts).toHaveLength(0);
		expect(screen.queryByText("This request across runs")).toBeNull();
	});

	it("draws nothing, and asks nothing, for a run with no requestId", () => {
		const { container } = renderTrend(null);

		expect(container.innerHTML).toBe("");
		expect(mocked.listRuns).not.toHaveBeenCalled();
	});

	it("includes a stopped run, marks it, and says so", async () => {
		answerWith([
			loadRun(3, { rps: 30, p95Ms: 300, errorRate: 3 }),
			loadRun(2, { rps: 20, p95Ms: 200, errorRate: 2 }, "stopped"),
			loadRun(1, { rps: 10, p95Ms: 100, errorRate: 1 }),
		]);
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		for (const chart of charts) {
			expect(chart.data[0]).toEqual([1, 2, 3]);
			expect(chart.annotations.map((a) => a.startSeconds)).toEqual([2]);
			expect(chart.xTooltipFormat(2)).toMatch(/- stopped/);
			expect(chart.xTooltipFormat(1)).not.toMatch(/stopped/);
		}
		expect(screen.getByText(/Stopped runs are included/)).toBeTruthy();
	});

	it("says nothing about stopped runs when none is in the series", async () => {
		answerWith(runs(3));
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		expect(screen.queryByText(/Stopped runs/)).toBeNull();
		expect(charts[0].annotations).toEqual([]);
	});

	it("marks the open run on its own position", async () => {
		answerWith(runs(4));
		renderTrend("req-1", "run-3");

		await waitFor(() => expect(charts).toHaveLength(3));
		for (const chart of charts) {
			expect(chart.markers).toEqual([
				expect.objectContaining({ value: 3, label: "This run" }),
			]);
			expect(chart.xTooltipFormat(3)).toMatch(/this run/);
		}
	});

	it("leaves a gap where a run did not record a figure, and drops a chart with fewer than two", async () => {
		answerWith([
			loadRun(3, { rps: 30, p95Ms: 300 }),
			loadRun(2, { rps: 20 }),
			loadRun(1, { rps: 10, p95Ms: 100, errorRate: 0 }),
		]);
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(2));
		expect(charts.map((c) => c.series[0].label)).toEqual(["p95 latency", "throughput"]);
		expect(charts[0].data[1]).toEqual([100, null, 300]);
	});

	it("labels each chart for a screen reader with the run count and newest figure", async () => {
		answerWith(runs(3));
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		const labels = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));
		expect(labels).toEqual([
			"p95 latency across 3 runs, oldest to newest, newest 300ms",
			"Throughput across 3 runs, oldest to newest, newest 30/s",
			"Error rate across 3 runs, oldest to newest, newest 3.0%",
		]);
	});

	it("says so when the open run is older than the plotted window", async () => {
		answerWith(runs(25));
		renderTrend("req-1", "run-1");

		await screen.findByText(/This run is not among them/);
	});

	it("reads a tiny error rate the way the History row does, never as 0.0%", async () => {
		answerWith([
			loadRun(2, { rps: 20, p95Ms: 200, errorRate: 0.04 }),
			loadRun(1, { rps: 10, p95Ms: 100, errorRate: 0.02 }),
		]);
		renderTrend();

		await waitFor(() => expect(charts).toHaveLength(3));
		const labels = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));
		expect(labels[2]).toBe("Error rate across 2 runs, oldest to newest, newest <0.1%");
	});

	it("shows a retryable error when the run list fails", async () => {
		mocked.listRuns.mockRejectedValueOnce(new Error("engine down"));
		renderTrend();

		await screen.findByText("Couldn't load this request's runs");
		answerWith(runs(3));
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));

		await waitFor(() => expect(charts).toHaveLength(3));
	});
});
