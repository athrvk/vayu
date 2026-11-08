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
 * A service still speaking for an older run cannot change the newer run its
 * store now holds (#3351).
 *
 * The real services against the real stores: the services' own suites mock the
 * store, so they can only pin which run a write names, and the stores' suites
 * call the writers directly. This is where the two meet. Only the socket, the
 * engine and the OS-facing services are stubbed.
 *
 * Mutation check: make `forRun` in `dashboard-store.ts` apply its write for any
 * run and the load rows redden; drop the run comparison from
 * `scenario-run-store`'s `setStreaming` and the scenario close row reddens -
 * the release the issue named, clearing a successor's flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isDashboardRunLive, useDashboardStore } from "@/stores";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import type { LoadTestMetrics, ScenarioStepEvent } from "@/types";

vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn(), disconnect: vi.fn() } }));
const { mockGetRunReport } = vi.hoisted(() => ({ mockGetRunReport: vi.fn() }));
vi.mock("./api", () => ({ apiService: { getRunReport: mockGetRunReport } }));
vi.mock("./wake-lock", () => ({
	wakeLock: { hold: vi.fn(), release: vi.fn() },
	WAKE_LOCK_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));
vi.mock("./notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("./notify")>()),
	systemNotify: { post: vi.fn(), availability: vi.fn() },
}));
vi.mock("./os-icon", () => ({ osIcon: { runFailed: vi.fn(), runFinished: vi.fn() } }));
vi.mock("./run-progress", () => ({
	runProgress: { claim: vi.fn(), report: vi.fn(), fail: vi.fn(), clear: vi.fn() },
	RUN_PROGRESS_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

import { sseClient } from "./sse-client";
import { loadTestService } from "./load-test-service";
import { scenarioRunService } from "./scenario-run-service";

/** The handlers the service handed the client for its run, by position. */
function connectArgs(): unknown[] {
	const calls = vi.mocked(sseClient.connect).mock.calls;
	return calls[calls.length - 1] as unknown[];
}

/** The services' private handlers, which the SSE client calls in production. */
type Handlers = {
	handleError: (e: Error) => void;
	handleSuperseded: () => void;
	handleClose: (status: "completed" | null, info?: { frame: boolean }) => Promise<void>;
};
const load = () => loadTestService as unknown as Handlers;
const scenario = () => scenarioRunService as unknown as Handlers;

const tick = { elapsed_seconds: 1, timestamp: 1000 } as LoadTestMetrics;
const step = {
	iteration: 0,
	stepIndex: 0,
	name: "Log in",
	outcome: "passed",
	statusCode: 200,
	latencyMs: 5,
} as ScenarioStepEvent;
const completedReport = { summary: {}, latency: {}, metadata: { status: "completed" } };

beforeEach(() => {
	vi.mocked(sseClient.connect).mockClear();
	mockGetRunReport.mockReset().mockResolvedValue(completedReport);
});

describe("a load-test service still holding an older run", () => {
	beforeEach(() => {
		useDashboardStore.getState().startRun("run_old");
		loadTestService.startMonitoring("run_old");
		// The dashboard moved on while the service still speaks for run_old.
		useDashboardStore.getState().startRun("run_new");
	});
	afterEach(() => loadTestService.stopMonitoring());

	it.each<[string, () => unknown]>([
		["a stream error", () => load().handleError(new Error("The connection closed."))],
		["a collection run taking the stream", () => load().handleSuperseded()],
		["a tick", () => (connectArgs()[1] as (m: LoadTestMetrics) => void)(tick)],
		["a close and its report", () => load().handleClose("completed", { frame: true })],
	])("leaves the newer run streaming after %s", async (_name, write) => {
		await write();

		const state = useDashboardStore.getState();
		expect(state.currentRunId).toBe("run_new");
		expect(state.phase).toEqual({ phase: "streaming" });
		expect(isDashboardRunLive(state.phase)).toBe(true);
		expect(state.historicalMetrics).toEqual([]);
	});
});

describe("a scenario-run service still holding an older run", () => {
	beforeEach(() => {
		scenarioRunService.startMonitoring("collection_old");
		useScenarioRunStore.getState().startRun("collection_new");
	});
	afterEach(() => scenario().handleSuperseded());

	it.each<[string, () => unknown]>([
		["a stream error", () => scenario().handleError(new Error("The connection closed."))],
		["a step", () => (connectArgs()[4] as (s: ScenarioStepEvent) => void)(step)],
		["a close", () => scenario().handleClose(null)],
		["a load run taking the stream", () => scenario().handleSuperseded()],
	])("leaves the newer run streaming after %s", async (_name, write) => {
		await write();

		const state = useScenarioRunStore.getState();
		expect(state.runId).toBe("collection_new");
		expect(state.isStreaming).toBe(true);
		expect(state.error).toBeNull();
		expect(state.steps).toEqual([]);
	});
});
