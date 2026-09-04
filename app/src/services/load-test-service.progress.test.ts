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
const { mockReport, mockFail, mockClear } = vi.hoisted(() => ({
	mockReport: vi.fn(),
	mockFail: vi.fn(),
	mockClear: vi.fn(),
}));
vi.mock("./run-progress", () => ({
	runProgress: { report: mockReport, fail: mockFail, clear: mockClear },
	RUN_PROGRESS_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
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
function closeStream(): Promise<void> {
	return (loadTestService as unknown as { handleClose: () => Promise<void> }).handleClose();
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

	it("claims the indicator when the run starts, with no fraction yet", () => {
		loadTestService.startMonitoring("run_1");
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, null);
	});

	it("reports the derived fraction on a committed batch", () => {
		loadTestService.startMonitoring("run_1");
		mockReport.mockClear();
		tickHandler()(tick(30));
		expect(mockDerive).toHaveBeenCalledWith(config, tick(30));
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, 0.5);
	});

	it("passes a run with no denominator through as null", () => {
		derived.value = null;
		loadTestService.startMonitoring("run_1");
		mockReport.mockClear();
		tickHandler()(tick(30));
		expect(mockReport).toHaveBeenCalledWith(LOAD_RUN, null);
	});

	it("gives the indicator up when the user stops the run", () => {
		loadTestService.startMonitoring("run_1");
		loadTestService.stopMonitoring();
		expect(mockClear).toHaveBeenCalledWith(LOAD_RUN);
	});

	it("gives it up when the run completes", async () => {
		loadTestService.startMonitoring("run_1");
		await closeStream();
		expect(mockClear).toHaveBeenCalledWith(LOAD_RUN);
	});

	it("says failed when the stream errors", () => {
		loadTestService.startMonitoring("run_1");
		failStream("engine went away");
		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN);
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
		expect(mockFail).toHaveBeenCalledWith(LOAD_RUN);
		expect(mockClear).not.toHaveBeenCalled();
	});
});
