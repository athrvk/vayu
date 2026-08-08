/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the run tab reads after a collection run ends.
 *
 * The step list has two sources and prefers the stored one, because only a
 * stored row carries the exchange a step expands into. Which means the refetch
 * on `complete` is not a nicety - it is the only thing that ever puts an
 * exchange on the screen, and it runs against a cache entry the run tab
 * populated seconds earlier with an empty `results[]` (the engine writes every
 * step row in one batch at the end).
 *
 * The real `QueryClient` is used here rather than a mock of it: what is under
 * test is whether TanStack's freshness rules let this fetch through, and a
 * mocked `fetchQuery` would answer that question by assumption. Revert the
 * `staleTime: 0` in the service and the second test fails - the cached empty
 * report is under five minutes old, so `fetchQuery` resolves from it and the
 * network is never touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSetStreaming = vi.fn();
const mockSetError = vi.fn();
const mockStartRun = vi.fn();
const mockAddStep = vi.fn();
vi.mock("@/stores/scenario-run-store", () => ({
	useScenarioRunStore: {
		getState: () => ({
			startRun: mockStartRun,
			addStep: mockAddStep,
			setStreaming: mockSetStreaming,
			setError: mockSetError,
		}),
	},
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn() } }));
vi.mock("./api", () => ({ apiService: { getRunReport: vi.fn() } }));

import { scenarioRunService } from "./scenario-run-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";

/** `handleClose` is private; the SSE client is what calls it in production. */
function closeStream(): Promise<void> {
	return (scenarioRunService as unknown as { handleClose: () => Promise<void> }).handleClose();
}

/** Reset the service's `activeRunId` between cases without exporting it. */
function resetService(): void {
	(scenarioRunService as unknown as { activeRunId: string | null }).activeRunId = null;
}

const emptyReport = { results: [], scenario: { stepsExecuted: 2, stepsStored: 0 } };
const storedReport = {
	results: [{ id: 1, timestamp: 1, statusCode: 200, latencyMs: 5 }],
	scenario: { stepsExecuted: 2, stepsStored: 2 },
};

describe("ScenarioRunService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryClient.clear();
		resetService();
	});

	it("attaches to the stream once per run, with a step handler", () => {
		scenarioRunService.startMonitoring("run_1");
		scenarioRunService.startMonitoring("run_1");

		expect(sseClient.connect).toHaveBeenCalledTimes(1);
		expect(mockStartRun).toHaveBeenCalledWith("run_1");
		expect(sseClient.connect).toHaveBeenCalledWith(
			"run_1",
			expect.any(Function),
			expect.any(Function),
			expect.any(Function),
			expect.any(Function)
		);
	});

	it("refetches the report over the empty one the run tab cached at start", async () => {
		// What the run tab's own `useRunReportQuery` put there when the tab
		// opened: the run had executed nothing, so the report has no rows.
		queryClient.setQueryData(queryKeys.runs.report("run_2"), emptyReport);

		vi.mocked(apiService.getRunReport).mockResolvedValue(
			storedReport as unknown as Awaited<ReturnType<typeof apiService.getRunReport>>
		);

		scenarioRunService.startMonitoring("run_2");
		await closeStream();

		expect(apiService.getRunReport).toHaveBeenCalledWith("run_2");
		// The cache now holds the stored steps, which is what the step list
		// switches to - and what carries the exchange each row expands into.
		expect(queryClient.getQueryData(queryKeys.runs.report("run_2"))).toEqual(storedReport);
	});

	it("marks the run and the history list stale so both leave 'running'", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		vi.mocked(apiService.getRunReport).mockResolvedValue(
			storedReport as unknown as Awaited<ReturnType<typeof apiService.getRunReport>>
		);

		scenarioRunService.startMonitoring("run_3");
		await closeStream();

		expect(mockSetStreaming).toHaveBeenCalledWith(false);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail("run_3") });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.lists() });
		invalidate.mockRestore();
	});

	it("keeps the run visible when the report refetch fails", async () => {
		queryClient.setQueryData(queryKeys.runs.report("run_4"), emptyReport);
		vi.mocked(apiService.getRunReport).mockRejectedValue(new Error("engine gone"));

		scenarioRunService.startMonitoring("run_4");
		// A rejected refetch must not reject `handleClose` - the SSE client
		// awaits it, and the stream's own teardown is not the report's business.
		await expect(closeStream()).resolves.toBeUndefined();
		expect(mockSetStreaming).toHaveBeenCalledWith(false);
	});
});
