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
 * Every failure the dashboard can record reaches the screen, with a way out
 * that works (#1925).
 *
 * This used to be a source scan that the writer and the reader of the stream
 * error existed. Both did, and neither was reached: a real drop never set the
 * error, and the report callout's Retry re-armed no effect. So it is driven
 * end to end here - the real `LoadTestService` against the real store, and the
 * real dashboard reading it. Only the engine and the SSE socket are stubbed,
 * and the dashboard's own children, whose suites cover them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import { TIMING } from "@/config/timing";
import type { RunReport } from "@/types";

const { mockGetRunReport, mockStartMonitoring } = vi.hoisted(() => ({
	mockGetRunReport: vi.fn(),
	mockStartMonitoring: vi.fn(),
}));
// What the real service reaches the engine through.
vi.mock("@/services/api", () => ({ apiService: { getRunReport: mockGetRunReport } }));
vi.mock("@/services/sse-client", () => ({
	sseClient: { connect: vi.fn(), disconnect: vi.fn() },
}));
// What the dashboard reaches the service through: Reconnect is asserted on the
// call it makes, and `isMonitoring` keeps the mount check from reconnecting
// on its own.
vi.mock("@/services", () => ({
	apiService: { getRunReport: mockGetRunReport },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: mockStartMonitoring,
		stopMonitoring: vi.fn(),
	},
}));
vi.mock("./components", () => ({
	DashboardHeader: () => null,
	MetricsView: () => null,
	RequestResponseView: () => null,
}));

import { loadTestService } from "@/services/load-test-service";
import LoadTestDashboard from "./index";

const reportWith = (status: string) =>
	({ summary: { totalRequests: 10 }, latency: {}, metadata: { status } }) as unknown as RunReport;

/** `handleClose` is private; the SSE client calls it, with `null` for a drop. */
function dropStream(): Promise<void> {
	return (
		loadTestService as unknown as { handleClose: (status: null) => Promise<void> }
	).handleClose(null);
}

/** How long a stubbed engine call takes to answer. */
const ROUND_TRIP_MS = 10;

/** Run every timer the dashboard can arm, and the promises they settle. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("dashboard error surfacing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockGetRunReport.mockReset();
		mockStartMonitoring.mockReset();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/*
	 * A stream that ends with no `complete` frame, for a run the engine still
	 * reports as running. Mutation checks: drop the `isRunInProgress` branch in
	 * `LoadTestService.handleClose` and the mode flips to "completed" with no
	 * callout; drop `streamError` from the dashboard's report effect guard and
	 * that effect fetches the live report anyway.
	 */
	it("shows a dropped stream for a live run as lost, not Completed", async () => {
		mockGetRunReport.mockResolvedValue(reportWith("running"));
		useDashboardStore.getState().startRun("run_drop");
		loadTestService.startMonitoring("run_drop");
		render(createElement(LoadTestDashboard));

		await act(() => dropStream());

		const state = useDashboardStore.getState();
		expect(state.mode).toBe("running");
		expect(state.finalReport).toBeNull();
		expect(state.error).not.toBeNull();
		expect(screen.getByText("Lost the live metrics stream")).toBeTruthy();

		// The run is live, so the stored report is not what the page waits on.
		const fetched = mockGetRunReport.mock.calls.length;
		await advance(TIMING.REPORT_INITIAL_DELAY_MS * 2);
		expect(mockGetRunReport.mock.calls.length).toBe(fetched);

		fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
		expect(mockStartMonitoring).toHaveBeenCalledWith("run_drop");
		expect(useDashboardStore.getState().error).toBeNull();
	});

	/*
	 * The stream stopped, the report could not be read, and the fetch gave up.
	 * Retry used to clear the error and nothing else: the effect that set it
	 * did not depend on it, and the retry-capped one was gated on a mode the
	 * run had not reached, so the callout went away and the page sat with no
	 * report. Mutation check: drop `reportError` from the effect's
	 * dependencies and Retry issues no fetch.
	 */
	it("fetches the report once more when Retry is pressed", async () => {
		// Rejected a round trip later, not in the same tick: the effect re-arms
		// on its loading flag going true and back, and two updates landing
		// before one render are batched into no change at all. For the same
		// reason each delay and each round trip below is its own `act`.
		mockGetRunReport.mockImplementation(
			() =>
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("Couldn't reach Vayu's engine.")),
						ROUND_TRIP_MS
					)
				)
		);
		useDashboardStore.getState().startRun("run_retry");
		useDashboardStore.getState().setStreaming(false);
		render(createElement(LoadTestDashboard));

		// The first attempt and every retry the cap allows.
		for (let i = 0; i <= TIMING.REPORT_MAX_ATTEMPTS; i++) {
			await advance(i === 0 ? TIMING.REPORT_INITIAL_DELAY_MS : TIMING.REPORT_RETRY_DELAY_MS);
			await advance(ROUND_TRIP_MS);
		}
		expect(screen.getByText("Couldn't load the run report")).toBeTruthy();

		const fetched = mockGetRunReport.mock.calls.length;
		mockGetRunReport.mockResolvedValueOnce(reportWith("completed"));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await advance(TIMING.REPORT_INITIAL_DELAY_MS);

		expect(mockGetRunReport.mock.calls.length - fetched).toBe(1);
		expect(mockGetRunReport).toHaveBeenLastCalledWith("run_retry");
		expect(useDashboardStore.getState().mode).toBe("completed");
		expect(screen.queryByText("Couldn't load the run report")).toBeNull();
	});
});
