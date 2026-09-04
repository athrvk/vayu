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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSetStreaming = vi.fn();
const mockSetError = vi.fn();
const mockStartRun = vi.fn();
const mockAddSteps = vi.fn();
/** The fold the store keeps beside the rows; the notification body reads it. */
const stepCounts = { passed: 0, failed: 0, skipped: 0, errored: 0 };
vi.mock("@/stores/scenario-run-store", () => ({
	useScenarioRunStore: {
		getState: () => ({
			startRun: mockStartRun,
			addSteps: mockAddSteps,
			setStreaming: mockSetStreaming,
			setError: mockSetError,
			summary: { counts: stepCounts, iterationSteps: 0, dataBoundSteps: 0 },
		}),
	},
}));
// The service reads the cadence from the settings store, and the user's
// standing answer on keeping the machine awake (#1357). Off is the default.
const settings = { keepAwakeDuringRuns: false };
vi.mock("@/stores", () => ({
	useClientSettingsStore: {
		getState: () => ({
			liveRefreshMs: FLUSH_MS,
			keepAwakeDuringRuns: settings.keepAwakeDuringRuns,
		}),
	},
}));
vi.mock("./sse-client", () => ({ sseClient: { connect: vi.fn() } }));
vi.mock("./api", () => ({ apiService: { getRunReport: vi.fn() } }));
const { mockWakeLockHold, mockWakeLockRelease } = vi.hoisted(() => ({
	mockWakeLockHold: vi.fn(),
	mockWakeLockRelease: vi.fn(),
}));
vi.mock("./wake-lock", () => ({
	wakeLock: { hold: mockWakeLockHold, release: mockWakeLockRelease },
	WAKE_LOCK_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));
// The system notification a terminal run posts (#1358), mocked at the service
// boundary the way the wake lock is.
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("./notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("./notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));

import { NOTIFY_KINDS } from "./notify";
import { scenarioRunService } from "./scenario-run-service";
import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { WAKE_LOCK_KEYS } from "./wake-lock";
import type { ScenarioStepEvent } from "@/types";

/** The live-refresh cadence these cases run at. */
const FLUSH_MS = 500;

/** `handleClose` is private; the SSE client is what calls it in production. */
function closeStream(): Promise<void> {
	return (scenarioRunService as unknown as { handleClose: () => Promise<void> }).handleClose();
}

/** Likewise `handleError` - a transport failure is what calls it. */
function failStream(message: string): void {
	(scenarioRunService as unknown as { handleError: (e: Error) => void }).handleError(
		new Error(message)
	);
}

/**
 * Deliver a step the way the stream does: through the handler the service
 * handed `sseClient.connect`, so the wiring is under test alongside the
 * buffering rather than reached around.
 */
function deliverStep(stepIndex: number): void {
	const calls = vi.mocked(sseClient.connect).mock.calls;
	const onStep = calls[calls.length - 1]?.[4];
	if (!onStep) throw new Error("the service registered no step handler");
	onStep({
		iteration: 0,
		stepIndex,
		name: `Step ${stepIndex + 1}`,
		outcome: "passed",
		statusCode: 200,
		latencyMs: 10,
	});
}

/** Every step of every batch committed so far, in order. */
function committedSteps(): ScenarioStepEvent[] {
	return mockAddSteps.mock.calls.flatMap((call) => call[0] as ScenarioStepEvent[]);
}

/** Reset the service's private stream state between cases. */
function resetService(): void {
	const internals = scenarioRunService as unknown as {
		activeRunId: string | null;
		discardPending: () => void;
	};
	internals.activeRunId = null;
	internals.discardPending();
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

	it("marks the run, the history list and the collection's Last run stale so all leave 'running'", async () => {
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		vi.mocked(apiService.getRunReport).mockResolvedValue(
			storedReport as unknown as Awaited<ReturnType<typeof apiService.getRunReport>>
		);

		scenarioRunService.startMonitoring("run_3");
		await closeStream();

		expect(mockSetStreaming).toHaveBeenCalledWith(false);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail("run_3") });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.lists() });
		// Its own family, outside `lists()`, and not polled - so the section
		// would sit on "Running" for the rest of the session without this.
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.runs.lastCollectionRuns(),
		});
		invalidate.mockRestore();
	});

	/**
	 * Issue #1153. The engine's scenario loop is sequential with no pacing, so a
	 * local target returns steps faster than the renderer can commit them one at
	 * a time. What is pinned here is that the number of store commits follows
	 * the cadence and not the event rate - and that no step is lost to the
	 * buffering on any path that ends a run.
	 */
	describe("buffering step events", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("commits one batch per flush window rather than one per event", () => {
			scenarioRunService.startMonitoring("run_5");

			// The first step commits on the leading edge: a reader watching a run
			// start should not wait a window to see it began.
			deliverStep(0);
			expect(mockAddSteps).toHaveBeenCalledTimes(1);

			// Everything inside the window rides one trailing commit, however
			// many arrive. Reverting the buffer makes this eight.
			for (let i = 1; i <= 8; i += 1) deliverStep(i);
			expect(mockAddSteps).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(FLUSH_MS);
			expect(mockAddSteps).toHaveBeenCalledTimes(2);
			expect(mockAddSteps.mock.calls[1][0]).toHaveLength(8);

			// Nothing is dropped in exchange for the commits saved.
			expect(committedSteps().map((s) => s.stepIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		});

		it("commits the buffer when the stream closes, before anything reads the list as final", async () => {
			scenarioRunService.startMonitoring("run_6");
			vi.mocked(apiService.getRunReport).mockResolvedValue(
				storedReport as unknown as Awaited<ReturnType<typeof apiService.getRunReport>>
			);

			deliverStep(0);
			deliverStep(1);
			// Still inside the window, so the second step is buffered: without a
			// flush here it would be the run's last step, lost between the
			// stream ending and the report arriving.
			expect(committedSteps()).toHaveLength(1);

			await closeStream();

			expect(committedSteps().map((s) => s.stepIndex)).toEqual([0, 1]);
		});

		it("commits the buffer when the stream fails, under the notice explaining why it stopped", () => {
			scenarioRunService.startMonitoring("run_7");

			deliverStep(0);
			deliverStep(1);
			failStream("engine gone");

			expect(committedSteps().map((s) => s.stepIndex)).toEqual([0, 1]);
			expect(mockSetError).toHaveBeenCalledWith("engine gone");
		});

		it("drops what a replaced run left buffered rather than committing it into the next", () => {
			scenarioRunService.startMonitoring("run_8");
			deliverStep(0);
			deliverStep(1);
			mockAddSteps.mockClear();

			// The store clears its rows for the new run, so the previous run's
			// buffered step belongs to a list nothing will show.
			scenarioRunService.startMonitoring("run_9");
			vi.advanceTimersByTime(FLUSH_MS * 2);

			expect(mockAddSteps).not.toHaveBeenCalled();
		});
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

	describe("wake lock (issue #1357)", () => {
		afterEach(() => {
			settings.keepAwakeDuringRuns = false;
		});

		it("holds nothing on start while the preference is off", () => {
			// A collection run is never prompted about either - it declares no
			// duration, so nothing can tell a two-second sequence from a long one.
			// The standing preference is its only route to a lock.
			scenarioRunService.startMonitoring("run_10a");
			expect(mockWakeLockHold).not.toHaveBeenCalled();
		});

		it("holds the collection-run key on start once the preference is on", () => {
			settings.keepAwakeDuringRuns = true;
			scenarioRunService.startMonitoring("run_10");
			// Pins the `wakeLock.hold(...)` call in `startMonitoring` and the
			// condition around it.
			expect(mockWakeLockHold).toHaveBeenCalledWith(
				WAKE_LOCK_KEYS.collectionRun,
				expect.any(String)
			);
		});

		it("releases the collection-run key when the stream closes, before the awaited fetches resolve", async () => {
			scenarioRunService.startMonitoring("run_11");
			mockWakeLockRelease.mockClear();

			let releaseCalledBeforeFetch = false;
			vi.mocked(apiService.getRunReport).mockImplementationOnce(() => {
				// Reverting the release's position in `handleClose` (moving it after
				// the `await Promise.all(...)`) leaves this false.
				releaseCalledBeforeFetch = mockWakeLockRelease.mock.calls.length > 0;
				return Promise.resolve(
					storedReport as unknown as Awaited<ReturnType<typeof apiService.getRunReport>>
				);
			});

			await closeStream();

			expect(releaseCalledBeforeFetch).toBe(true);
			expect(mockWakeLockRelease).toHaveBeenCalledWith(WAKE_LOCK_KEYS.collectionRun);
		});

		it("releases the collection-run key on a stream error", () => {
			scenarioRunService.startMonitoring("run_12");
			mockWakeLockRelease.mockClear();
			failStream("engine gone");
			// Pins the `wakeLock.release(...)` call in `handleError`.
			expect(mockWakeLockRelease).toHaveBeenCalledWith(WAKE_LOCK_KEYS.collectionRun);
		});
	});

	describe("system notifications (issue #1358)", () => {
		afterEach(() => {
			Object.assign(stepCounts, { passed: 0, failed: 0, skipped: 0, errored: 0 });
		});

		it("posts the run's outcome counts when the stream closes", async () => {
			Object.assign(stepCounts, { passed: 41, failed: 2 });
			scenarioRunService.startMonitoring("run_13");

			await closeStream();

			expect(mockNotifyPost).toHaveBeenCalledWith({
				kind: NOTIFY_KINDS.collectionRunFinished,
				title: "Collection run finished",
				body: "41 passed, 2 failed",
				target: { view: "run", runId: "run_13" },
			});
		});

		it("names errored and skipped steps only when there are some", async () => {
			Object.assign(stepCounts, { passed: 3, failed: 0, errored: 1, skipped: 2 });
			scenarioRunService.startMonitoring("run_14");

			await closeStream();

			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({ body: "3 passed, 0 failed, 1 errored, 2 skipped" })
			);
		});

		it("posts once for a run that fails and then closes", async () => {
			scenarioRunService.startMonitoring("run_15");

			failStream("engine gone");
			await closeStream();

			// Pins the per-run latch: one run ending is one notification, and the
			// one the user gets is the one that says what went wrong.
			expect(mockNotifyPost).toHaveBeenCalledTimes(1);
			expect(mockNotifyPost).toHaveBeenCalledWith(
				expect.objectContaining({
					kind: NOTIFY_KINDS.collectionRunFailed,
					body: "engine gone",
				})
			);
		});
	});
});
