/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSetStreaming = vi.fn();
const mockSetError = vi.fn();
const mockSetFinalReport = vi.fn();
const mockReset = vi.fn();
const mockAddMetricsBatch = vi.fn();
// Which run the dashboard is showing *right now* - re-read after every await,
// which is the whole point of the guard under test.
const dashboard = { currentRunId: null as string | null };
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			currentRunId: dashboard.currentRunId,
			setStreaming: mockSetStreaming,
			setError: mockSetError,
			setFinalReport: mockSetFinalReport,
			reset: mockReset,
			addMetricsBatch: mockAddMetricsBatch,
		}),
	},
	useClientSettingsStore: { getState: () => ({ liveRefreshMs: 0 }) },
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock("./api", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }) },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";

/** `handleClose` is private; the SSE client is what calls it in production. */
function closeStream(): Promise<void> {
	return (loadTestService as unknown as { handleClose: () => Promise<void> }).handleClose();
}

describe("LoadTestService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dashboard.currentRunId = null;
	});
	afterEach(() => loadTestService.stopMonitoring());

	it("connects to SSE synchronously (no setTimeout delay)", () => {
		loadTestService.startMonitoring("run_1");
		expect(sseClient.connect).toHaveBeenCalledTimes(1);
		expect(sseClient.connect).toHaveBeenCalledWith(
			"run_1",
			expect.any(Function),
			expect.any(Function),
			expect.any(Function)
		);
	});

	it("fetches the stored report once when the run completes (terminal convergence)", async () => {
		dashboard.currentRunId = "run_2";
		loadTestService.startMonitoring("run_2");
		await closeStream();
		expect(apiService.getRunReport).toHaveBeenCalledWith("run_2");
		expect(mockSetFinalReport).toHaveBeenCalled();
	});

	/*
	 * Finish run A, start run B before A's report comes back. The fetch is one
	 * local round trip, so the window is small and entirely reachable: A's
	 * report landed on B's dashboard, flipping a running test to "completed"
	 * with A's percentiles. The store is therefore re-read *after* the await,
	 * not captured before it.
	 */
	it("drops a finished run's report when the dashboard has moved to another run", async () => {
		dashboard.currentRunId = "run_A";
		loadTestService.startMonitoring("run_A");

		let release: () => void = () => {};
		vi.mocked(apiService.getRunReport).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ summary: {}, latency: {} } as never);
				})
		);

		const closed = closeStream();
		// The user starts run B while A's report is still in flight.
		dashboard.currentRunId = "run_B";
		release();
		await closed;

		expect(apiService.getRunReport).toHaveBeenCalledWith("run_A");
		expect(mockSetFinalReport).not.toHaveBeenCalled();
	});

	// Regression guard: the caller invokes store.startRun() first (which registers
	// currentRunId + clears the series). startMonitoring must NOT call store.reset()
	// - doing so nulls currentRunId and the dashboard shows "no active tests".
	it("does not reset the store on start (would wipe the active run registered by startRun)", () => {
		loadTestService.startMonitoring("run_3");
		expect(mockReset).not.toHaveBeenCalled();
	});
});
