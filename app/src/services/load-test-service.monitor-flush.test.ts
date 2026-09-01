/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monitor scrapes ride the metrics flush - the part of `LoadTestService` that
 * the shared batcher (issue #1206) deliberately does not know about.
 *
 * The batcher owns one buffer and commits nothing for an empty one, so the
 * pairing of ticks and scrapes had to stay here. That makes the seam worth its
 * own cases: before the extraction a single `flushMetrics` guard covered "one
 * of the two lists has something", and the case where only the scrape list does
 * was covered by nothing.
 *
 * A sibling file rather than cases inside `load-test-service.test.ts`, whose
 * store mock declares no `addMonitorSamples` - #1206 asks that suite to pass
 * unchanged, as the proof that no behaviour moved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoadTestMetrics, MonitorSample } from "@/types";

const mockAddMetricsBatch = vi.fn();
const mockAddMonitorSamples = vi.fn();
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			currentRunId: null,
			setStreaming: vi.fn(),
			setError: vi.fn(),
			setFinalReport: vi.fn(),
			addMetricsBatch: mockAddMetricsBatch,
			addMonitorSamples: mockAddMonitorSamples,
		}),
	},
	// The module default (500ms) applies, so a window is a window.
	useClientSettingsStore: { getState: () => ({ liveRefreshMs: 0 }) },
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock("./api", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }) },
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";
import { METRICS_UI_THROTTLE_MS } from "@/config/metrics";

type MetricsHandler = (m: LoadTestMetrics) => void;
type MonitorHandler = (s: MonitorSample) => void;

/** The handlers the service handed the SSE client for the active run. */
function streamHandlers(): { tick: MetricsHandler; scrape: MonitorHandler } {
	const calls = vi.mocked(sseClient.connect).mock.calls;
	const call = calls[calls.length - 1];
	if (!call) throw new Error("startMonitoring did not connect");
	return { tick: call[1] as MetricsHandler, scrape: call[5] as MonitorHandler };
}

/** `handleClose` is private; the SSE client is what calls it in production. */
function closeStream(): Promise<void> {
	return (loadTestService as unknown as { handleClose: () => Promise<void> }).handleClose();
}

/**
 * Reset the singleton's stream state between cases, so each one starts on the
 * leading edge the way a fresh run does.
 */
function resetService(): void {
	const internals = loadTestService as unknown as {
		activeRunId: string | null;
		pendingMonitor: MonitorSample[];
		metricsBatcher: { discard: () => void };
	};
	internals.activeRunId = null;
	internals.pendingMonitor = [];
	internals.metricsBatcher.discard();
}

const tickAt = (timestamp: number) => ({ timestamp }) as unknown as LoadTestMetrics;
const scrapeAt = (timestamp: number) => ({ timestamp }) as unknown as MonitorSample;

describe("LoadTestService - scrapes riding the metrics flush", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		resetService();
	});
	afterEach(() => {
		resetService();
		vi.useRealTimers();
	});

	it("commits a scrape and the tick it arrived beside in the same flush", () => {
		loadTestService.startMonitoring("run_1");
		const { tick, scrape } = streamHandlers();

		scrape(scrapeAt(1));
		tick(tickAt(1)); // leading edge

		expect(mockAddMetricsBatch).toHaveBeenCalledTimes(1);
		expect(mockAddMonitorSamples).toHaveBeenCalledTimes(1);
		expect(mockAddMonitorSamples).toHaveBeenLastCalledWith([scrapeAt(1)]);
	});

	it("carries a scrape that arrived inside the window on the trailing commit", () => {
		loadTestService.startMonitoring("run_2");
		const { tick, scrape } = streamHandlers();

		tick(tickAt(1)); // leading edge
		mockAddMonitorSamples.mockClear();
		scrape(scrapeAt(2));
		tick(tickAt(2));

		// A scrape has no timer of its own - it waits for the next tick's flush.
		expect(mockAddMonitorSamples).not.toHaveBeenCalled();
		vi.advanceTimersByTime(METRICS_UI_THROTTLE_MS);
		expect(mockAddMonitorSamples).toHaveBeenLastCalledWith([scrapeAt(2)]);
	});

	it("commits a scrape the run ended before any tick could carry", async () => {
		loadTestService.startMonitoring("run_3");
		const { scrape } = streamHandlers();

		// The whole point: no tick is buffered, so the batcher commits nothing,
		// and the scrape is left holding the only unflushed state there is.
		scrape(scrapeAt(3));
		await closeStream();

		// The mutation check: drop the `pendingMonitor` drain from `flushPending`
		// and this scrape is silently lost at the end of every run that ends
		// between ticks.
		expect(mockAddMonitorSamples).toHaveBeenCalledTimes(1);
		expect(mockAddMonitorSamples).toHaveBeenLastCalledWith([scrapeAt(3)]);
		// Beside an empty tick batch, which is what this did before the batcher.
		expect(mockAddMetricsBatch).toHaveBeenLastCalledWith([]);
	});

	it("drops what a stopped run left buffered rather than committing it late", () => {
		loadTestService.startMonitoring("run_4");
		const { tick, scrape } = streamHandlers();

		tick(tickAt(1)); // leading edge
		tick(tickAt(2)); // buffered behind the window
		scrape(scrapeAt(1));
		mockAddMetricsBatch.mockClear();
		mockAddMonitorSamples.mockClear();

		loadTestService.stopMonitoring();
		vi.advanceTimersByTime(METRICS_UI_THROTTLE_MS * 2);

		// Both buffers dropped, and the trailing timer with them.
		expect(mockAddMetricsBatch).not.toHaveBeenCalled();
		expect(mockAddMonitorSamples).not.toHaveBeenCalled();
	});
});
