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
const mockAddMetricsBatch = vi.fn();
// Which run the dashboard is showing *right now* - re-read after every await,
// which is the whole point of the guard under test.
const dashboard = { currentRunId: null as string | null };
// The user's standing answer to "keep this machine awake" (#1357), which the
// service reads at start. Off is the shipped default, so it is the default here.
const settings = { keepAwakeDuringRuns: false };
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			currentRunId: dashboard.currentRunId,
			setStreaming: mockSetStreaming,
			setError: mockSetError,
			setFinalReport: mockSetFinalReport,
			addMetricsBatch: mockAddMetricsBatch,
		}),
	},
	useClientSettingsStore: {
		getState: () => ({ liveRefreshMs: 0, keepAwakeDuringRuns: settings.keepAwakeDuringRuns }),
	},
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock("./api", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }) },
}));
const { mockWakeLockHold, mockWakeLockRelease } = vi.hoisted(() => ({
	mockWakeLockHold: vi.fn(),
	mockWakeLockRelease: vi.fn(),
}));
vi.mock("./wake-lock", () => ({
	wakeLock: { hold: mockWakeLockHold, release: mockWakeLockRelease },
	WAKE_LOCK_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { WAKE_LOCK_KEYS } from "./wake-lock";

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
			expect.any(Function),
			// No step handler - a load run emits none - but a monitor handler,
			// because a run configured with a `monitor` block streams its
			// scrapes on this same connection.
			undefined,
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

	// The guard this replaces asserted `store.reset()` was not called on start -
	// doing so nulls the currentRunId that startRun just registered and the
	// dashboard shows "no active tests". The store no longer has a `reset`, so
	// that mistake is now a compile error rather than a mock assertion. What is
	// still worth pinning is the positive form: start only opens the stream.
	it("only opens the stream on start, touching no run state the caller registered", () => {
		loadTestService.startMonitoring("run_3");
		expect(mockSetStreaming).toHaveBeenCalledWith(true);
		expect(mockSetError).toHaveBeenCalledWith(null);
		expect(mockSetFinalReport).not.toHaveBeenCalled();
		expect(mockAddMetricsBatch).not.toHaveBeenCalled();
	});

	describe("wake lock (issue #1357)", () => {
		afterEach(() => {
			settings.keepAwakeDuringRuns = false;
		});

		it("holds nothing on start while the preference is off", () => {
			// The shipped default. Overriding the machine's power settings is the
			// user's decision, so a run takes no lock until they have made it -
			// `KeepAwakePrompt` is what asks, for a run long enough to matter.
			loadTestService.startMonitoring("run_4a");
			expect(mockWakeLockHold).not.toHaveBeenCalled();
		});

		it("holds the load-run key on start once the preference is on", () => {
			settings.keepAwakeDuringRuns = true;
			loadTestService.startMonitoring("run_4");
			// Pins the `wakeLock.hold(...)` call in `startMonitoring`, and the
			// condition around it: drop the condition and the case above fails,
			// drop the call and this one does.
			expect(mockWakeLockHold).toHaveBeenCalledWith(
				WAKE_LOCK_KEYS.loadRun,
				expect.any(String)
			);
		});

		it("releases the load-run key on stop", () => {
			loadTestService.startMonitoring("run_5");
			mockWakeLockRelease.mockClear();
			loadTestService.stopMonitoring();
			// Pins the `wakeLock.release(...)` call in `stopMonitoring`.
			expect(mockWakeLockRelease).toHaveBeenCalledWith(WAKE_LOCK_KEYS.loadRun);
		});

		it("releases the load-run key when the stream closes, before the report fetch resolves", async () => {
			dashboard.currentRunId = "run_6";
			loadTestService.startMonitoring("run_6");
			mockWakeLockRelease.mockClear();

			let releaseCalledBeforeFetch = false;
			vi.mocked(apiService.getRunReport).mockImplementationOnce(() => {
				// The lock must already be gone by the time the report fetch is
				// even asked for - reverting the release's position in `handleClose`
				// (moving it after the `await`) leaves this false.
				releaseCalledBeforeFetch = mockWakeLockRelease.mock.calls.length > 0;
				return Promise.resolve({ summary: {}, latency: {} } as never);
			});

			await closeStream();

			expect(releaseCalledBeforeFetch).toBe(true);
			expect(mockWakeLockRelease).toHaveBeenCalledWith(WAKE_LOCK_KEYS.loadRun);
		});

		it("releases the load-run key on a stream error", () => {
			loadTestService.startMonitoring("run_7");
			mockWakeLockRelease.mockClear();
			(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
				new Error("transport gone")
			);
			// Pins the `wakeLock.release(...)` call in `handleError`.
			expect(mockWakeLockRelease).toHaveBeenCalledWith(WAKE_LOCK_KEYS.loadRun);
		});
	});
});
