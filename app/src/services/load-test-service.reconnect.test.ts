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
 * Reconnect to a load run whose stream was lost (#3571): the series the
 * dashboard holds must carry on from the last frame it saw, not restart.
 *
 * The real service, client and dashboard store meet through a stubbed global
 * `EventSource` that behaves like the engine's route: a connection opened with
 * `?lastEventId=N` is sent the retained frames after N, and one opened without
 * is sent the whole ring. `load-test-service.test.ts` mocks the client and so
 * cannot see the URL this is about.
 *
 * Mutation check: stop sending the parameter in `SSEClient.connect` and the
 * series cases redden with every retained tick delivered a second time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { RunReport } from "@/types";

const { mockGetRunReport } = vi.hoisted(() => ({ mockGetRunReport: vi.fn() }));
vi.mock("./api", () => ({ apiService: { getRunReport: mockGetRunReport } }));
vi.mock("./wake-lock", () => ({
	wakeLock: { hold: vi.fn(), release: vi.fn() },
	WAKE_LOCK_KEYS: { loadRun: "load-run" },
}));
vi.mock("./notify", () => ({
	systemNotify: { post: vi.fn() },
	NOTIFY_KINDS: {
		loadRunFinished: "load-run-finished",
		loadRunStopped: "load-run-stopped",
		loadRunFailed: "load-run-failed",
	},
}));
vi.mock("./os-icon", () => ({ osIcon: { runFailed: vi.fn(), runFinished: vi.fn() } }));
vi.mock("./run-progress", () => ({
	runProgress: { claim: vi.fn(), report: vi.fn(), fail: vi.fn(), clear: vi.fn() },
	RUN_PROGRESS_KEYS: { loadRun: "load-run" },
}));

import { loadTestService } from "./load-test-service";

interface RetainedFrame {
	type: "metrics" | "monitor";
	payload: object;
}

/** The engine's retained ring for one run: frame ids are the indexes, from 0. */
let ring: RetainedFrame[] = [];

const tickFrame = (elapsedSeconds: number): RetainedFrame => ({
	type: "metrics",
	payload: {
		timestamp: 1_700_000_000_000 + elapsedSeconds * 1000,
		elapsedSeconds,
		totalRequests: elapsedSeconds * 100,
		currentRps: 100,
	},
});
const scrapeFrame = (at: number): RetainedFrame => ({
	type: "monitor",
	payload: { timestamp: 1_700_000_000_000 + at, series: { cpu: 0.5 } },
});

class EngineStream {
	static instances: EngineStream[] = [];
	static OPEN = 1;
	static CLOSED = 2;
	readyState = EngineStream.OPEN;
	private readonly listeners = new Map<string, (event: MessageEvent) => void>();
	constructor(readonly url: string) {
		EngineStream.instances.push(this);
	}
	addEventListener(type: string, fn: (event: MessageEvent) => void): void {
		this.listeners.set(type, fn);
	}
	close(): void {
		this.readyState = EngineStream.CLOSED;
	}

	/** The id the engine resumes after, or null for a connection that sent none. */
	get resumeAfter(): number | null {
		const raw = new URL(this.url).searchParams.get("lastEventId");
		return raw === null ? null : Number(raw);
	}

	/** Send the frames the engine would: the whole ring, or those after the resume id. */
	deliverRetained(): void {
		const first = this.resumeAfter === null ? 0 : this.resumeAfter + 1;
		for (let id = first; id < ring.length; id++) {
			const frame = ring[id];
			if (!frame) continue;
			this.listeners.get(frame.type)?.({
				data: JSON.stringify(frame.payload),
				lastEventId: String(id),
			} as MessageEvent);
		}
	}
	/** The browser giving up on the connection. */
	drop(): void {
		this.readyState = EngineStream.CLOSED;
		this.listeners.get("error")?.({} as MessageEvent);
	}
}

const stream = (index: number): EngineStream => {
	const found = EngineStream.instances[index];
	if (!found) throw new Error(`no stream ${index}`);
	return found;
};

const store = () => useDashboardStore.getState();
const reportWithStatus = (status: string) =>
	({ metadata: { status }, summary: {}, latency: {} }) as unknown as RunReport;

/** The browser gives up on the open stream while the engine still reports the run live. */
async function loseStream(): Promise<void> {
	mockGetRunReport.mockResolvedValue(reportWithStatus("running"));
	stream(EngineStream.instances.length - 1).drop();
	await waitFor(() => expect(store().phase.phase).toBe("streamLost"));
}

let caseNumber = 0;
let runId = "";

beforeEach(() => {
	caseNumber += 1;
	runId = `run_reconnect_${caseNumber}`;
	ring = [];
	EngineStream.instances = [];
	vi.stubGlobal("EventSource", EngineStream);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	// The service is a singleton whose throttle outlives a case, and a case that
	// ended on a lost stream leaves the last commit's time behind: a run that
	// starts inside that window buffers its first tick instead of committing it.
	// Releasing a run is what puts the throttle back on its leading edge.
	loadTestService.startMonitoring("throttle_reset");
	loadTestService.stopMonitoring();
	EngineStream.instances = [];
	// A fresh run, as `startRun` registers it before any stream attaches.
	store().startRun(runId);
});

afterEach(() => {
	loadTestService.stopMonitoring();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Reconnect after a lost stream (#3571)", () => {
	it("continues the series from the last tick held, with no tick drawn twice", async () => {
		// Frames 0-3 reach the dashboard before the drop; 4-6 happen while it is down.
		ring = [tickFrame(1), tickFrame(2), scrapeFrame(2500), tickFrame(3)];
		loadTestService.startMonitoring(runId);
		stream(0).deliverRetained();
		await loseStream();
		ring.push(tickFrame(4), scrapeFrame(4500), tickFrame(5));

		loadTestService.startMonitoring(runId);
		expect(stream(1).url).toMatch(/\?lastEventId=3$/);
		stream(1).deliverRetained();
		await loseStream();

		const elapsed = store().historicalMetrics.map((tick) => tick.elapsed_seconds);
		expect(elapsed).toEqual([1, 2, 3, 4, 5]);
		// The scrape that sat between ticks is held once too, not re-delivered.
		expect(store().monitorSamples).toHaveLength(2);
	});

	it("never takes the header's reading back to zero", async () => {
		ring = [tickFrame(1), tickFrame(2), tickFrame(3)];
		const readings: Array<number | undefined> = [];
		const unsubscribe = useDashboardStore.subscribe((state) => {
			readings.push(state.currentMetrics?.elapsed_seconds);
		});
		loadTestService.startMonitoring(runId);
		stream(0).deliverRetained();
		await loseStream();
		ring.push(tickFrame(4));

		loadTestService.startMonitoring(runId);
		stream(1).deliverRetained();
		await loseStream();
		unsubscribe();

		const seen = readings.filter((value): value is number => value !== undefined);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		expect(seen).not.toContain(0);
		expect(store().currentMetrics?.elapsed_seconds).toBe(4);
	});

	it("commits what a lost stream had buffered once, and does not deliver it again", async () => {
		// The second tick lands inside the leading tick's window, so it is still
		// in the throttle buffer when the stream drops.
		ring = [tickFrame(1), tickFrame(2)];
		loadTestService.startMonitoring(runId);
		stream(0).deliverRetained();
		expect(store().historicalMetrics).toHaveLength(1);
		await loseStream();
		expect(store().historicalMetrics).toHaveLength(2);

		loadTestService.startMonitoring(runId);
		stream(1).deliverRetained();
		await loseStream();

		expect(store().historicalMetrics.map((tick) => tick.elapsed_seconds)).toEqual([1, 2]);
	});

	it("replays a first attach from offset 0, with no parameter", async () => {
		ring = [tickFrame(1), tickFrame(2)];
		loadTestService.startMonitoring(runId);

		expect(stream(0).url).not.toContain("lastEventId");
		stream(0).deliverRetained();
		await loseStream();
		expect(store().historicalMetrics.map((tick) => tick.elapsed_seconds)).toEqual([1, 2]);
	});
});
