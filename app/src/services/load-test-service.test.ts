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
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			setStreaming: mockSetStreaming,
			setError: mockSetError,
			setFinalReport: mockSetFinalReport,
			addMetricsBatch: mockAddMetricsBatch,
		}),
	},
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock("./api", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }) },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";

describe("LoadTestService", () => {
	beforeEach(() => vi.clearAllMocks());
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
		loadTestService.startMonitoring("run_2");
		await (loadTestService as unknown as { handleClose: () => Promise<void> }).handleClose();
		expect(apiService.getRunReport).toHaveBeenCalledWith("run_2");
		expect(mockSetFinalReport).toHaveBeenCalled();
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
});
