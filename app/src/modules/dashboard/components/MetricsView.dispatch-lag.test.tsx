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
 * What the Send / Throughput chip is judged on during a live run (#2802): the
 * tick's windowed send and completion rates, held for a few seconds, not the
 * cumulative pair printed beside it (which parts by in-flight / elapsed on any
 * healthy open-model run).
 */

import { beforeEach, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";
import type { DisplayMetrics } from "../types";
import MetricsView from "./MetricsView";

/** 500 req/s against a 100 ms target, 2 s in: 50 in flight over 2 s is a 25 req/s cumulative gap. */
const healthy: DisplayMetrics = {
	requests_completed: 950,
	requests_failed: 0,
	current_rps: 500,
	current_send_rate: 500,
	send_rate: 500,
	throughput: 475,
	avg_latency_ms: 100,
	bytes_sent: 0,
	bytes_received: 0,
};

function ticksTo(elapsed: number, m: DisplayMetrics): LoadTestMetrics[] {
	return [{ ...m, timestamp: 0, elapsed_seconds: elapsed, current_concurrency: 0 }];
}

function renderRow(metrics: DisplayMetrics, elapsed: number, lagSince: number | null) {
	useDashboardStore.setState({ dispatchLagSinceSeconds: lagSince });
	render(
		<TooltipProvider>
			<MetricsView
				metrics={metrics}
				historicalMetrics={ticksTo(elapsed, metrics)}
				mode="constant_rps"
				targetRps={500}
			/>
		</TooltipProvider>
	);
}

describe("MetricsView dispatch chip", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("r");
	});

	it("reads kept pace when the windowed rates agree, whatever the cumulative gap", () => {
		renderRow(healthy, 2, null);

		expect(screen.getByText("Δ 25 req/s")).toBeTruthy();
		expect(screen.getByText("server kept pace with dispatch")).toBeTruthy();
	});

	it("reads lagging once the windowed gap has been held", () => {
		renderRow({ ...healthy, current_rps: 350 }, 8, 4);

		expect(screen.getByText("server is lagging dispatch")).toBeTruthy();
	});

	it("stays grey for a windowed gap that has not been held yet", () => {
		renderRow({ ...healthy, current_rps: 350 }, 8, 6);

		expect(screen.getByText("still measuring the gap")).toBeTruthy();
		expect(screen.queryByText("server is lagging dispatch")).toBeNull();
	});

	it("stays grey in the first second, before responses can have caught up", () => {
		renderRow({ ...healthy, current_rps: 0, avg_latency_ms: 0 }, 0.5, 0.1);

		expect(screen.getByText("still measuring the gap")).toBeTruthy();
	});

	it("draws no chip for a tick with no windowed send rate", () => {
		renderRow({ ...healthy, current_send_rate: undefined }, 8, null);

		expect(screen.queryByText(/server (kept pace|is lagging)/)).toBeNull();
		expect(screen.queryByText("still measuring the gap")).toBeNull();
	});
});
