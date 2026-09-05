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
			loadTestConfig: null,
			setStreaming: mockSetStreaming,
			setError: mockSetError,
			setFinalReport: mockSetFinalReport,
			addMetricsBatch: mockAddMetricsBatch,
		}),
	},
	useClientSettingsStore: {
		getState: () => ({ liveRefreshMs: 0, keepAwakeDuringRuns: settings.keepAwakeDuringRuns }),
	},
	// The fraction a committed batch carries to the taskbar (#1362). No batch is
	// committed in this suite; the wiring has its own file.
	deriveRunProgress: () => null,
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
// The system notification a terminal run posts (#1358). Mocked at the service
// boundary: whether the OS shows it is `electron/notify.ts`'s question, and
// whether the user asked for it is `services/notify.ts`'s.
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("./notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("./notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));
// The Dock/taskbar mark for a failed run (#1364), mocked at the same boundary
// as `notify` above: whether and how the OS shows it is `electron/os-icon.ts`'s
// question.
const { mockOsIconRunFailed, mockOsIconRunFinished } = vi.hoisted(() => ({
	mockOsIconRunFailed: vi.fn(),
	mockOsIconRunFinished: vi.fn(),
}));
vi.mock("./os-icon", () => ({
	osIcon: {
		captured: vi.fn(),
		inboxOpened: vi.fn(),
		runFailed: mockOsIconRunFailed,
		runFinished: mockOsIconRunFinished,
		recents: vi.fn(),
	},
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { WAKE_LOCK_KEYS } from "./wake-lock";
import { NOTIFY_KINDS } from "./notify";

/**
 * `handleClose` is private; the SSE client is what calls it in production, with
 * the status off the engine's completion frame (#1415). `null` is a stream that
 * ended without one - a dropped connection, or an older engine.
 */
function closeStream(status: "Completed" | "Stopped" | "Failed" | null = null): Promise<void> {
	return (
		loadTestService as unknown as {
			handleClose: (status: "Completed" | "Stopped" | "Failed" | null) => Promise<void>;
		}
	).handleClose(status);
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

	describe("system notifications (issue #1358)", () => {
		function failStream(message: string): void {
			(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
				new Error(message)
			);
		}

		it("posts what the run did, not that it is over", async () => {
			dashboard.currentRunId = "run_8";
			vi.mocked(apiService.getRunReport).mockResolvedValueOnce({
				summary: { totalRequests: 12400, errorRate: 0.3 },
				latency: { p95: 210.4 },
			} as never);
			loadTestService.startMonitoring("run_8");

			await closeStream();

			expect(mockNotifyPost).toHaveBeenCalledWith({
				kind: NOTIFY_KINDS.loadRunFinished,
				title: "Load test finished",
				body: "12,400 requests, p95 210 ms, 0.3% errors",
				target: { view: "run", runId: "run_8" },
			});
		});

		it("says so plainly when the report cannot supply the numbers", async () => {
			// The shipped fixture for a report the engine answered with nothing
			// usable. Reverting `runSummaryLine`'s checks turns this body into
			// "0 requests, p95 0 ms, 0.0% errors" - numbers the user would read as
			// their run's own.
			dashboard.currentRunId = "run_9";
			loadTestService.startMonitoring("run_9");

			await closeStream();

			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: NOTIFY_KINDS.loadRunFinished,
					body: "The run ended, but its report could not be read.",
				})
			);
		});

		it("posts the failure, with the reason", () => {
			loadTestService.startMonitoring("run_10");

			failStream("transport gone");

			expect(mockNotifyPost).toHaveBeenCalledWith({
				kind: NOTIFY_KINDS.loadRunFailed,
				title: "Load test failed",
				body: "transport gone",
				target: { view: "run", runId: "run_10" },
			});
		});

		it("posts once for a run that fails and then closes", async () => {
			dashboard.currentRunId = "run_11";
			loadTestService.startMonitoring("run_11");

			failStream("transport gone");
			await closeStream();

			// Pins the per-run latch. Drop it and a failed run tells the user twice,
			// the second time that it "finished".
			expect(mockNotifyPost).toHaveBeenCalledTimes(1);
			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({ kind: NOTIFY_KINDS.loadRunFailed })
			);
		});

		it("posts a stop as a stop", () => {
			loadTestService.startMonitoring("run_12");

			loadTestService.stopMonitoring();

			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({ kind: NOTIFY_KINDS.loadRunStopped })
			);
		});
	});

	describe("Dock/taskbar mark for a failed run (issue #1364)", () => {
		function failStream(message: string): void {
			(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
				new Error(message)
			);
		}

		it("marks the icon when a run fails", () => {
			loadTestService.startMonitoring("run_13");

			failStream("transport gone");

			expect(mockOsIconRunFailed).toHaveBeenCalledTimes(1);
		});

		/*
		 * Mutation check: call `osIcon.runFailed()` beside `runProgress.fail` in
		 * `handleError` instead of inside `notifyTerminal`, and this reddens -
		 * `notifyTerminal`'s `notifiedRunId` latch is what a genuinely once-only
		 * mark depends on; a call sitting beside `runProgress.fail` would fire
		 * again for a run whose failure had already been reported.
		 */
		it("does not mark the icon a second time for a run already reported failed", async () => {
			dashboard.currentRunId = "run_14";
			loadTestService.startMonitoring("run_14");

			failStream("transport gone");
			await closeStream();

			expect(mockOsIconRunFailed).toHaveBeenCalledTimes(1);
		});

		it("does not mark the icon for a run that finishes cleanly", async () => {
			dashboard.currentRunId = "run_15";
			loadTestService.startMonitoring("run_15");

			await closeStream();

			expect(mockOsIconRunFailed).not.toHaveBeenCalled();
		});

		/*
		 * The quieter cue (#1364 item 4): a run the user was not watching ended,
		 * so the taskbar button flashes where the notification they turned off
		 * would have spoken. The service sends it for every terminal state; the
		 * opt-in check and the platform rules are the two layers below.
		 *
		 * Mutation check: drop the `runFinished` call from `notifyTerminal` and
		 * this reddens - a user with notifications off would get nothing at all
		 * when a run ends, which is the gap the cue exists to close.
		 */
		it("raises the quieter end-of-run cue for a run that finished", async () => {
			dashboard.currentRunId = "run_15b";
			loadTestService.startMonitoring("run_15b");

			await closeStream();

			expect(mockOsIconRunFinished).toHaveBeenCalledTimes(1);
		});

		/*
		 * Mutation check: send it for every kind and this reddens. A stopped run
		 * is one the user pressed Stop on, so they were at the window and need
		 * no cue that it ended.
		 */
		/*
		 * #1415: until the completion frame's status was read, every terminal
		 * close reported `loadRunFinished` - so a failed run notified "finished",
		 * left the taskbar bar unmarked and never reached this icon mark at all.
		 *
		 * Mutation check: go back to the unconditional `loadRunFinished` and
		 * this reddens, which is the whole of what #1415 was.
		 */
		it("marks the icon when the engine's frame says the run failed", async () => {
			dashboard.currentRunId = "run_15d";
			loadTestService.startMonitoring("run_15d");

			await closeStream("Failed");

			expect(mockOsIconRunFailed).toHaveBeenCalledTimes(1);
			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({ kind: NOTIFY_KINDS.loadRunFailed })
			);
		});

		/*
		 * The fallback, for a stream that ended without a frame - a dropped
		 * connection, or an engine older than #1415's change. Mutation check:
		 * drop the `reportStatus` half and this reddens while the case above
		 * still passes, which is why both are here.
		 */
		it("falls back to the stored report when the frame carried no status", async () => {
			vi.mocked(apiService.getRunReport).mockResolvedValueOnce({
				summary: {},
				latency: {},
				metadata: { status: "Failed" },
			} as Awaited<ReturnType<typeof apiService.getRunReport>>);
			dashboard.currentRunId = "run_15e";
			loadTestService.startMonitoring("run_15e");

			await closeStream(null);

			expect(mockOsIconRunFailed).toHaveBeenCalledTimes(1);
		});

		it("still says finished when neither the frame nor the report says otherwise", async () => {
			dashboard.currentRunId = "run_15f";
			loadTestService.startMonitoring("run_15f");

			await closeStream("Completed");

			expect(mockOsIconRunFailed).not.toHaveBeenCalled();
			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({ kind: NOTIFY_KINDS.loadRunFinished })
			);
		});

		it("raises no cue for a run the user stopped themselves", () => {
			loadTestService.startMonitoring("run_15c");

			loadTestService.stopMonitoring();

			expect(mockOsIconRunFinished).not.toHaveBeenCalled();
		});

		it("does not mark the icon for a run the user stopped", () => {
			loadTestService.startMonitoring("run_16");

			loadTestService.stopMonitoring();

			expect(mockOsIconRunFailed).not.toHaveBeenCalled();
		});
	});
});
