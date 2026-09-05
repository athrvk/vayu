/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What happens to a run when the *other* service's run takes the stream
 * (issue #1417).
 *
 * A file of its own, and the one place in this suite that runs the real
 * `sseClient`: every other service test mocks it, which is exactly why this gap
 * survived - a mocked client has no takeover to observe, so a cross-service
 * case written in either service's own suite would pass against the bug. The
 * global `EventSource` is stubbed instead, so the two real services meet
 * through the real singleton.
 *
 * Mutation check for the whole file: drop `handleSuperseded` from either
 * service's `connect` call, or the `supersede()` at the top of
 * `SSEClient.connect`, and the release cases redden - the wake lock is never
 * handed back and the machine stays awake for the rest of the session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The user's standing answer on keeping the machine awake (#1357). */
const settings = { keepAwakeDuringRuns: true };
const mockDashboardSetStreaming = vi.fn();
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({
			currentRunId: null,
			loadTestConfig: {},
			setStreaming: mockDashboardSetStreaming,
			setError: vi.fn(),
			setFinalReport: vi.fn(),
			addMetricsBatch: vi.fn(),
			addMonitorSamples: vi.fn(),
		}),
	},
	useClientSettingsStore: {
		getState: () => ({
			liveRefreshMs: 0,
			keepAwakeDuringRuns: settings.keepAwakeDuringRuns,
		}),
	},
	deriveRunProgress: () => null,
}));
const mockScenarioSetStreaming = vi.fn();
vi.mock("@/stores/scenario-run-store", () => ({
	useScenarioRunStore: {
		getState: () => ({
			startRun: vi.fn(),
			addSteps: vi.fn(),
			setStreaming: mockScenarioSetStreaming,
			setError: vi.fn(),
			summary: { counts: { passed: 0, failed: 0, skipped: 0, errored: 0 } },
		}),
	},
}));
const { mockGetRunReport } = vi.hoisted(() => ({
	mockGetRunReport: vi.fn().mockResolvedValue({ summary: {}, latency: {} }),
}));
vi.mock("./api", () => ({ apiService: { getRunReport: mockGetRunReport } }));
const { mockWakeLockHold, mockWakeLockRelease } = vi.hoisted(() => ({
	mockWakeLockHold: vi.fn(),
	mockWakeLockRelease: vi.fn(),
}));
vi.mock("./wake-lock", () => ({
	wakeLock: { hold: mockWakeLockHold, release: mockWakeLockRelease },
	WAKE_LOCK_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("./notify", () => ({
	systemNotify: { post: mockNotifyPost },
	NOTIFY_KINDS: {
		loadRunFinished: "load-run-finished",
		loadRunStopped: "load-run-stopped",
		loadRunFailed: "load-run-failed",
		collectionRunFinished: "collection-run-finished",
		collectionRunFailed: "collection-run-failed",
	},
}));
const { mockIconFailed, mockIconFinished } = vi.hoisted(() => ({
	mockIconFailed: vi.fn(),
	mockIconFinished: vi.fn(),
}));
vi.mock("./os-icon", () => ({
	osIcon: { runFailed: mockIconFailed, runFinished: mockIconFinished },
}));
const { mockProgressClaim, mockProgressClear } = vi.hoisted(() => ({
	mockProgressClaim: vi.fn(),
	mockProgressClear: vi.fn(),
}));
vi.mock("./run-progress", () => ({
	runProgress: {
		claim: mockProgressClaim,
		report: vi.fn(),
		fail: vi.fn(),
		clear: mockProgressClear,
	},
	RUN_PROGRESS_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

import { loadTestService } from "./load-test-service";
import { scenarioRunService } from "./scenario-run-service";

/** Enough of `EventSource` for the client to open, close and read a state. */
class MockEventSource {
	static instances: MockEventSource[] = [];
	static CLOSED = 2;
	readyState = 1;
	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}
	addEventListener(): void {}
	close(): void {
		this.readyState = MockEventSource.CLOSED;
	}
}

const LOAD_KEY = "load-run";
const COLLECTION_KEY = "collection-run";

/**
 * A fresh pair of run ids for one case.
 *
 * Both services are module singletons that outlive a case, and their
 * `notifiedRunId` guard is per run and never reset - by design, so a run gets
 * one notification whatever ends it. A case reusing an id another case has
 * already finished would therefore be told nothing and pass by accident.
 */
let caseNumber = 0;
function runIds(): { load: string; collection: string } {
	caseNumber += 1;
	return { load: `load_${caseNumber}`, collection: `coll_${caseNumber}` };
}

/** How many sockets the two services have opened between them. */
function sockets(): MockEventSource[] {
	return MockEventSource.instances;
}

describe("a run superseded by the other service's run", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		settings.keepAwakeDuringRuns = true;
		MockEventSource.instances = [];
		vi.stubGlobal("EventSource", MockEventSource);
	});
	afterEach(() => {
		// Leave both services watching nothing, so one case's run cannot be the
		// thing the next case's first run supersedes. The load service can stop
		// itself; the scenario service deliberately has no stop (its stream ends
		// on the engine's frame), so a throwaway load run displaces whatever it
		// held and is then stopped in turn.
		loadTestService.startMonitoring(`teardown_${caseNumber}`);
		loadTestService.stopMonitoring();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("hands the load run's wake lock back when a collection run takes the stream", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		expect(mockWakeLockHold).toHaveBeenCalledWith(LOAD_KEY, expect.any(String));
		mockWakeLockRelease.mockClear();

		scenarioRunService.startMonitoring(collection);

		// Once, in the same tick the new stream connects: the whole defect was a
		// lock held for the rest of the session because no terminal path ran.
		expect(mockWakeLockRelease).toHaveBeenCalledWith(LOAD_KEY);
		expect(mockWakeLockRelease.mock.calls.filter((c) => c[0] === LOAD_KEY)).toHaveLength(1);
		// The run that took the stream keeps its own lock.
		expect(mockWakeLockHold).toHaveBeenCalledWith(COLLECTION_KEY, expect.any(String));
	});

	it("hands the collection run's wake lock back when a load run takes the stream", () => {
		const { load, collection } = runIds();
		scenarioRunService.startMonitoring(collection);
		expect(mockWakeLockHold).toHaveBeenCalledWith(COLLECTION_KEY, expect.any(String));
		mockWakeLockRelease.mockClear();

		loadTestService.startMonitoring(load);

		expect(mockWakeLockRelease).toHaveBeenCalledWith(COLLECTION_KEY);
		expect(mockWakeLockRelease.mock.calls.filter((c) => c[0] === COLLECTION_KEY)).toHaveLength(
			1
		);
	});

	/*
	 * The superseded run has not ended - the engine is still running it - so
	 * saying "finished" would be a lie the user hears in their notification
	 * centre, and the failed-run icon mark reads the same terminal path (#1364).
	 */
	it("says nothing about a run it merely stopped watching", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		scenarioRunService.startMonitoring(collection);

		expect(mockNotifyPost).not.toHaveBeenCalled();
		expect(mockIconFinished).not.toHaveBeenCalled();
		expect(mockIconFailed).not.toHaveBeenCalled();
		// Nor does it fetch the report of a run it is no longer watching.
		expect(mockGetRunReport).not.toHaveBeenCalled();
	});

	it("says nothing about a superseded collection run either", () => {
		const { load, collection } = runIds();
		scenarioRunService.startMonitoring(collection);
		loadTestService.startMonitoring(load);

		expect(mockNotifyPost).not.toHaveBeenCalled();
		expect(mockIconFinished).not.toHaveBeenCalled();
		expect(mockGetRunReport).not.toHaveBeenCalled();
	});

	it("gives up the superseded run's OS progress claim", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		expect(mockProgressClaim).toHaveBeenCalledWith(LOAD_KEY, load);
		mockProgressClear.mockClear();

		scenarioRunService.startMonitoring(collection);

		// Named by run, not by kind: a clear that named only the key could wipe
		// the bar of whatever run is being watched now (#1405).
		expect(mockProgressClear).toHaveBeenCalledWith(LOAD_KEY, load);
	});

	/*
	 * `UrlBar` disables Send while `isStreaming` is true and
	 * `useHostSleepRecorder` reads it to decide which run a suspend belongs to,
	 * so a flag left raised for a stream that is gone is not cosmetic.
	 */
	it("lowers the superseded run's streaming flag", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		mockDashboardSetStreaming.mockClear();

		scenarioRunService.startMonitoring(collection);

		expect(mockDashboardSetStreaming).toHaveBeenCalledWith(false);
	});

	it("lowers the superseded collection run's streaming flag", () => {
		const { load, collection } = runIds();
		scenarioRunService.startMonitoring(collection);
		mockScenarioSetStreaming.mockClear();

		loadTestService.startMonitoring(load);

		expect(mockScenarioSetStreaming).toHaveBeenCalledWith(false);
	});

	it("leaves the superseded run's socket closed and the new one open", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		scenarioRunService.startMonitoring(collection);

		expect(sockets()).toHaveLength(2);
		expect(sockets()[0]?.readyState).toBe(MockEventSource.CLOSED);
		expect(sockets()[1]?.readyState).toBe(1);
	});

	/*
	 * The same-service case was already handled and must stay that way: the
	 * load service stops itself before reconnecting, which both says what ended
	 * the run and disconnects the client, so the new hand-off has nobody to
	 * tell. Mutation check: drop the `stopMonitoring()` call from
	 * `startMonitoring` and the notification asserted below never happens.
	 *
	 * What this does *not* pin is that `disconnect()` drops the registration -
	 * `stopMonitoring` nulls `activeRunId` before disconnecting, so this
	 * service's own `handleSuperseded` would early-return either way. That rule
	 * is pinned where it lives, on the client (`sse-client.test.ts`).
	 */
	it("does not double up on a run superseded by its own service", () => {
		const { load } = runIds();
		const next = runIds().load;
		loadTestService.startMonitoring(load);
		mockNotifyPost.mockClear();
		mockDashboardSetStreaming.mockClear();

		loadTestService.startMonitoring(next);

		// The one thing `stopMonitoring` has always said, and only it.
		expect(mockNotifyPost).toHaveBeenCalledTimes(1);
		expect(mockNotifyPost.mock.calls[0]?.[0]).toMatchObject({
			kind: "load-run-stopped",
			target: { view: "run", runId: load },
		});
		expect(mockDashboardSetStreaming).not.toHaveBeenCalledWith(false);
	});

	/*
	 * The failed-run flash is a two-second mark the main process times out on
	 * its own, so clearing it in the tick it was painted wipes it (#1362,
	 * #1364). Every path that lets go of a run leaves it alone, and being
	 * superseded is now one of those paths. Mutation check: drop the
	 * `progressFailedRunId` guard from `releaseRun` and this reddens.
	 *
	 * Reached through the private handler the way the sibling suites do: in
	 * production `onError` fires only when opening the stream threw, which
	 * leaves no hand-off registered, so this pins the rule rather than a
	 * reachable sequence - the rule is what a future caller of `releaseRun`
	 * would otherwise have to re-derive from another file.
	 */
	it("leaves a superseded run's failure flash alone", () => {
		const { load, collection } = runIds();
		loadTestService.startMonitoring(load);
		(loadTestService as unknown as { handleError: (e: Error) => void }).handleError(
			new Error("stream refused")
		);
		mockProgressClear.mockClear();

		scenarioRunService.startMonitoring(collection);

		expect(mockProgressClear).not.toHaveBeenCalledWith(LOAD_KEY, load);
	});

	/*
	 * The same-service rule holds on the collection side too, and it is the
	 * side with no `stopMonitoring` to lean on (#1417): `startMonitoring` ends
	 * the run it replaces itself. Mutation check: drop that ending and the
	 * hand-off registered against this very service fires for the run that
	 * just started - it releases the lock it took a line earlier, wipes the bar
	 * it just claimed, and nulls the run id, so every assertion below reddens.
	 */
	it("leaves a collection run that replaced another holding its own lock and bar", () => {
		const first = runIds().collection;
		const second = runIds().collection;
		scenarioRunService.startMonitoring(first);
		mockWakeLockHold.mockClear();
		mockWakeLockRelease.mockClear();
		mockProgressClaim.mockClear();
		mockProgressClear.mockClear();

		scenarioRunService.startMonitoring(second);

		// The run that left gives up what it held, named by run so the arriving
		// run's bar is not what gets wiped (#1405).
		expect(mockProgressClear).toHaveBeenCalledWith(COLLECTION_KEY, first);
		expect(mockProgressClear).not.toHaveBeenCalledWith(COLLECTION_KEY, second);
		expect(mockProgressClaim).toHaveBeenCalledWith(COLLECTION_KEY, second);
		// Released for the run that left and taken again for the one that
		// arrived, in that order - the key is held by kind, so a release after
		// the new hold would leave the machine free to sleep under a live run.
		expect(mockWakeLockRelease).toHaveBeenCalledWith(COLLECTION_KEY);
		expect(mockWakeLockHold).toHaveBeenCalledWith(COLLECTION_KEY, expect.any(String));
		expect(mockWakeLockRelease.mock.invocationCallOrder[0]).toBeLessThan(
			mockWakeLockHold.mock.invocationCallOrder[0] ?? 0
		);
		// And the run that left is still not spoken for: it has not ended.
		expect(mockNotifyPost).not.toHaveBeenCalled();
	});

	/*
	 * Acceptance criterion 3 for the collection side: a run that happens to
	 * have replaced another must end exactly as a first run does. This is what
	 * the regression cost - `handleClose` read a null run id and returned
	 * before any of it.
	 */
	it("still ends a collection run normally after it replaced another", async () => {
		const first = runIds().collection;
		const second = runIds().collection;
		scenarioRunService.startMonitoring(first);
		scenarioRunService.startMonitoring(second);
		mockNotifyPost.mockClear();
		mockGetRunReport.mockClear();

		await (
			scenarioRunService as unknown as {
				handleClose: (status: string | null) => Promise<void>;
			}
		).handleClose("Completed");

		expect(mockNotifyPost).toHaveBeenCalledTimes(1);
		expect(mockNotifyPost.mock.calls[0]?.[0]).toMatchObject({
			kind: "collection-run-finished",
			target: { view: "run", runId: second },
		});
		expect(mockGetRunReport).toHaveBeenCalledWith(second);
	});

	it("holds no lock for a superseded run when the setting is off", () => {
		const { load, collection } = runIds();
		settings.keepAwakeDuringRuns = false;
		loadTestService.startMonitoring(load);
		scenarioRunService.startMonitoring(collection);

		expect(mockWakeLockHold).not.toHaveBeenCalled();
		// The release is unconditional and harmless - `wake-lock` treats a key it
		// does not hold as a no-op - but the run must still let go of everything
		// else it claimed.
		expect(mockProgressClear).toHaveBeenCalledWith(LOAD_KEY, load);
	});
});
