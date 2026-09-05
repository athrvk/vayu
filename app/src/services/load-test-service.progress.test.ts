/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What `LoadTestService` tells the taskbar and Dock indicator, and when (#1362).
 *
 * A sibling file rather than cases inside `load-test-service.test.ts`: driving a
 * flush needs a store mock carrying `addMonitorSamples`, and that suite's mock
 * deliberately declares none (see the note in `load-test-service.monitor-flush
 * .test.ts`). What the fraction is derived *from* is `dashboard-store.test.ts`'s
 * question; this file is about which value reaches the indicator, and when.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoadTestMetrics } from "@/types";

const config = { duration: "60s" };
const derived = { value: 0.5 as number | null };
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			currentRunId: null,
			loadTestConfig: config,
			setStreaming: vi.fn(),
			setError: vi.fn(),
			setFinalReport: vi.fn(),
			addMetricsBatch: vi.fn(),
			addMonitorSamples: vi.fn(),
		}),
	},
	useClientSettingsStore: { getState: () => ({ liveRefreshMs: 0, keepAwakeDuringRuns: false }) },
	deriveRunProgress: (...args: unknown[]) => mockDerive(...args),
}));
const mockDerive = vi.fn((..._args: unknown[]) => derived.value);
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock("./api", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }) },
}));
const { mockClaim, mockReport, mockFail, mockClear } = vi.hoisted(() => ({
	mockClaim: vi.fn(),
	mockReport: vi.fn(),
	mockFail: vi.fn(),
	mockClear: vi.fn(),
}));
vi.mock("./run-progress", () => ({
	runProgress: { claim: mockClaim, report: mockReport, fail: mockFail, clear: mockClear },
	RUN_PROGRESS_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { RUN_PROGRESS_KEYS } from "./run-progress";

const LOAD_RUN = RUN_PROGRESS_KEYS.loadRun;

/** The tick handler the service handed the SSE client for the active run. */
function tickHandler(): (metrics: LoadTestMetrics) => void {
	const calls = vi.mocked(sseClient.connect).mock.calls;
	const call = calls[calls.length - 1];
	if (!call) throw new Error("startMonitoring did not connect");
	return call[1] as (metrics: LoadTestMetrics) => void;
}

function tick(elapsed: number): LoadTestMetrics {
	return { elapsed_seconds: elapsed } as LoadTestMetrics;
}

/** The two private handlers the SSE client calls in production. */
function closeStream(status: "Completed" | "Stopped" | "Failed" | null = null): Promise<void> {
	return (
		loadTestService as unknown as {
			handleClose: (status: "Completed" | "Stopped" | "Failed" | null) => Promise<void>;
		}
	).handleClose(status);
}
function failStream(message: string): void {
	(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
		new Error(message)
	);
}

describe("LoadTestService - the OS progress indicator", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		derived.value = 0.5;
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		loadTestService.stopMonitoring();
		vi.restoreAllMocks();
	});

	/*
	 * The run id on every one of these is the point of #1405: the indicator is
	 * claimed by the run, not by the kind, so a call that named only `load-run`
	 * would let a superseded run paint over the run being watched. Mutation
	 * check on each: pass anything but this run's id and the case reddens.
	 */
	it("claims the indicator for the run that started, with no fraction yet", () => {
		loadTestService.startMonitoring("run_1");
		expect(mockClaim).toHaveBeenCalledWith(LOAD_RUN, "run_1");
	});

	it("reports the derived fraction on a committed batch", () => {
		loadTestService.startMonitoring("run_1");
		mockReport.mockClear();
		tickHandler()(tick(30));
		expect(mockDerive).toHaveBeenCalledWith(config, tick(30));
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, "run_1", 0.5);
	});

	it("passes a run with no denominator through as null", () => {
		derived.value = null;
		loadTestService.startMonitoring("run_1");
		mockReport.mockClear();
		tickHandler()(tick(30));
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, "run_1", null);
	});

	it("gives the indicator up when the user stops the run", () => {
		loadTestService.startMonitoring("run_1");
		loadTestService.stopMonitoring();
		expect(mockClear).toHaveBeenCalledWith(LOAD_RUN, "run_1");
	});

	it("gives it up when the run completes", async () => {
		loadTestService.startMonitoring("run_1");
		await closeStream();
		expect(mockClear).toHaveBeenCalledWith(LOAD_RUN, "run_1");
	});

	it("says failed when the stream errors", () => {
		loadTestService.startMonitoring("run_1");
		failStream("engine went away");
		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN, "run_1");
	});

	/*
	 * The terminal fetch in `handleClose` is awaited, and a run started inside
	 * that window has already put its own id on the service. Forgetting it there
	 * would leave the service unable to name the run it is watching, and since
	 * #1405 that is what every call to the indicator turns on: the live run's
	 * fraction would be dropped from then on and its bar never cleared.
	 *
	 * Mutation check: drop the `this.activeRunId === runId` guard on the
	 * assignment and the report below arrives naming `null`.
	 */
	it("keeps naming the run that started while the last one's report was in flight", async () => {
		type RunReport = Awaited<ReturnType<typeof apiService.getRunReport>>;
		let deliverReport: (report: RunReport) => void = () => {};
		vi.mocked(apiService.getRunReport).mockReturnValueOnce(
			new Promise<RunReport>((resolve) => {
				deliverReport = resolve;
			})
		);

		loadTestService.startMonitoring("run_1");
		const closing = closeStream();
		// The user starts the next run before the first one's report lands.
		loadTestService.startMonitoring("run_2");
		deliverReport({ summary: {}, latency: {} } as unknown as RunReport);
		await closing;

		mockReport.mockClear();
		tickHandler()(tick(10));
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, "run_2", 0.5);
	});

	/*
	 * Mutation check: drop the `progressFailedRunId` guard in `handleClose` and
	 * the clear lands in the same tick as the failure, so the taskbar's error
	 * state is gone before anyone could see it - a failed run then looks exactly
	 * like one that finished.
	 */
	it("leaves a failed run's flash alone when its stream closes", async () => {
		loadTestService.startMonitoring("run_1");
		failStream("engine went away");
		await closeStream();
		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN, "run_1");
		expect(mockClear).not.toHaveBeenCalled();
	});

	/*
	 * #1415's third criterion, and the half that was still missing after the
	 * frame's status started choosing the notification kind: a run that fails
	 * on the engine ends through `handleClose`, not `handleError`, so until the
	 * failed frame painted the bar itself the Windows taskbar error state was
	 * never reached by a real failure - the close cleared the bar instead.
	 *
	 * Mutation check: drop the `status === "Failed"` branch in `handleClose`
	 * and this reddens twice over - no `fail`, and a `clear` that wipes the bar
	 * the criterion is about.
	 */
	it("says failed when the engine's frame says the run failed", async () => {
		loadTestService.startMonitoring("run_3");

		await closeStream("Failed");

		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN, "run_3");
		expect(mockClear).not.toHaveBeenCalled();
	});

	it("clears rather than reddens when the frame says the run completed", async () => {
		loadTestService.startMonitoring("run_4");

		await closeStream("Completed");

		expect(mockFail).not.toHaveBeenCalled();
		expect(mockClear).toHaveBeenCalledWith(LOAD_RUN, "run_4");
	});

	/*
	 * The bar is painted before the awaited report fetch, which is the same
	 * reason the notification prefers the frame to the stored row (#1415's
	 * fourth criterion): a failure whose report could not be read is still a
	 * failure, and the taskbar must say so.
	 *
	 * Mutation check: move the `fail` call after the fetch and this reddens.
	 */
	it("reddens a failed run whose report could not be read", async () => {
		vi.mocked(apiService.getRunReport).mockRejectedValueOnce(new Error("engine gone"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		loadTestService.startMonitoring("run_5");

		await closeStream("Failed");

		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN, "run_5");
		expect(mockClear).not.toHaveBeenCalled();
	});
});
