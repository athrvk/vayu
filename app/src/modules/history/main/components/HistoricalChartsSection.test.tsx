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
 * A failed time-series fetch is not "insufficient data" (#1944).
 *
 * The query settles as an error with `data` undefined, which the caller turns
 * into `[]`, and `[]` used to fall into the "need at least 2 seconds of data"
 * sentence - blaming a run that had plenty. The charts are stubbed: this pins
 * which of the section's states a fetch outcome lands in, not what uPlot draws.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LoadTestMetrics } from "@/types";
import { CONCURRENCY_UNIT, IN_FLIGHT_LABEL } from "@/constants/load-test-modes";

vi.mock("@/modules/dashboard/components/charts/uplot", () => {
	const stub = (name: string) => () => <div data-testid={name} />;
	return {
		RequestRateChart: stub("rate-chart"),
		ConnectionsChart: stub("connections-chart"),
		StatusCodesOverTimeChart: stub("status-chart"),
		ServerVitalsChart: stub("vitals-chart"),
		CustomMetricsChart: stub("custom-chart"),
		CHART_SYNC: { history: "history" },
	};
});

const HistoricalChartsSection = (await import("./HistoricalChartsSection")).default;

const INSUFFICIENT = /Not enough data for charts yet/;

function ticks(n: number): LoadTestMetrics[] {
	return Array.from({ length: n }, (_, i) => ({
		timestamp: i * 1000,
		elapsed_seconds: i,
		requests_completed: i * 100,
		requests_failed: 0,
		current_rps: 100,
		current_concurrency: 10,
		latency_p50_ms: 20,
		latency_p95_ms: 40,
		latency_p99_ms: 60,
		avg_latency_ms: 25,
		bytes_sent: 0,
		bytes_received: 0,
	}));
}

describe("HistoricalChartsSection, fetch failure", () => {
	it("shows the error with a working retry, not the insufficient-data sentence, when nothing loaded", () => {
		const retry = vi.fn();

		render(
			<HistoricalChartsSection data={[]} failure={{ message: "Failed to fetch", retry }} />
		);

		expect(screen.getByText("Couldn't load the time-series data")).toBeTruthy();
		expect(screen.getByText("Failed to fetch")).toBeTruthy();
		expect(screen.queryByText(INSUFFICIENT)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it("still says there is too little data when the fetch succeeded", () => {
		render(<HistoricalChartsSection data={ticks(1)} />);

		expect(screen.getByText(INSUFFICIENT)).toBeTruthy();
		expect(screen.getByText("Charts need at least 2 seconds of data.")).toBeTruthy();
		// The shared EmptyState, not a bare line of text.
		expect(document.querySelector('[data-slot="empty-state"]')).not.toBeNull();
		expect(screen.queryByText("Couldn't load the time-series data")).toBeNull();
	});

	it("keeps the loading state while a retry is in flight", () => {
		render(
			<HistoricalChartsSection
				data={[]}
				isLoading
				failure={{ message: "Failed to fetch", retry: vi.fn() }}
			/>
		);

		// A labelled skeleton, not a spinner card with a sentence.
		expect(screen.getByRole("status", { name: "Loading time-series data" })).toBeTruthy();
		expect(screen.queryByText("Couldn't load the time-series data")).toBeNull();
	});

	it("keeps the loaded charts, with no error over them, when a refetch failed", () => {
		render(
			<HistoricalChartsSection
				data={ticks(1000)}
				failure={{ message: "Failed to fetch", retry: vi.fn() }}
			/>
		);

		expect(screen.getByTestId("rate-chart")).toBeTruthy();
		expect(screen.queryByText("Couldn't load the time-series data")).toBeNull();
	});
});

/*
 * The reader of the envelope's `bucketed` / `ticksPerBucket` (#2547): a chart of
 * a downsampled series says what one of its points is.
 *
 * Mutation check: drop the note from the section and the bucketed case
 * reddens; draw it unconditionally and the raw case does.
 */
describe("HistoricalChartsSection, downsampled series", () => {
	const NOTE = /Each point covers/;

	it("says what a point covers, and what events are judged over, when the engine bucketed the series", () => {
		render(<HistoricalChartsSection data={ticks(10)} ticksPerBucket={44} />);

		expect(screen.getByText(/Each point covers 44\.00s of this run/)).toBeTruthy();
		expect(screen.getByText(/a slowdown has to span two\s+points to be named/)).toBeTruthy();
		expect(screen.getByTestId("rate-chart")).toBeTruthy();
	});

	it("draws no note over a raw series", () => {
		render(<HistoricalChartsSection data={ticks(10)} />);

		expect(screen.getByTestId("rate-chart")).toBeTruthy();
		expect(screen.queryByText(NOTE)).toBeNull();
	});
});

describe("HistoricalChartsSection, concurrency card title", () => {
	it.each(["ramp_up", "capacity", "constant_concurrency", "iterations"])(
		"counts virtual users for a closed-loop %s run",
		(mode) => {
			render(<HistoricalChartsSection data={ticks(10)} mode={mode} />);
			expect(screen.getByText(`Active ${CONCURRENCY_UNIT}`)).toBeTruthy();
			expect(screen.queryByText(IN_FLIGHT_LABEL)).toBeNull();
		}
	);

	it("counts requests in flight for a Constant RPS run, which holds no users", () => {
		render(<HistoricalChartsSection data={ticks(10)} mode="constant_rps" />);
		expect(screen.getByText(IN_FLIGHT_LABEL)).toBeTruthy();
		expect(screen.queryByText(`Active ${CONCURRENCY_UNIT}`)).toBeNull();
	});
});
