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
 * The health poll is the only thing that carries the engine's startup recovery
 * record into the app (issue #922), and a field written by no one is the
 * mirror image of this codebase's most repeated defect. So this asserts the
 * wiring rather than the shape: the node reaches the store `RecoveryBanner`
 * reads, and a clean answer clears it.
 *
 * It is also where the engine's status is decided (#1164). The poll is the only
 * thing that can tell a launch whose engine is still starting from one whose
 * engine is not coming, so the last block below drives that decision from both
 * sides and pins the budget it spends against the main process's own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getHealth = vi.fn();
vi.mock("@/services/api", () => ({ apiService: { getHealth: () => getHealth() } }));
// The engine dropping out is one of the events that may reach the user in
// another application (#1358). Mocked at the service boundary: whether the OS
// shows it is `electron/notify.ts`'s question.
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { useHealthQuery, healthPollIntervalMs, engineStatusAfterFailedPoll } from "./health";
import { useEngineStore } from "@/stores";
import { NOTIFY_KINDS } from "@/services/notify";
import { TIMING } from "@/config/timing";
import type { EngineRecovery } from "@/types/domain";

const RECOVERY: EngineRecovery = {
	outcome: "deleted_corrupt",
	at: 1_755_870_000_000,
	databasePath: "/home/someone/.vayu/vayu.db",
};

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
	vi.clearAllMocks();
	// Implementation too, not just the call record: a queued `…Once` rejection
	// left behind by a case that ended early is a failure in the next test.
	getHealth.mockReset();
	useEngineStore.setState({
		engineStatus: "starting",
		engineError: null,
		recovery: null,
		engineStartWindow: null,
	});
});

describe("useHealthQuery", () => {
	it("carries a reported recovery into the engine store", async () => {
		getHealth.mockResolvedValue({
			status: "ok",
			version: "1.0.0",
			workers: 8,
			recovery: RECOVERY,
		});

		renderHook(() => useHealthQuery(), { wrapper });

		await waitFor(() => expect(useEngineStore.getState().recovery).toEqual(RECOVERY));
	});

	it("clears the record when the engine reports a clean start", async () => {
		// Absent is a clean start, and the engine answering now is the authority
		// on its own startup - a stale record left in place would keep
		// announcing a wipe that a restarted engine no longer reports.
		useEngineStore.setState({ recovery: RECOVERY });
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });

		renderHook(() => useHealthQuery(), { wrapper });

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));
		expect(useEngineStore.getState().recovery).toBeNull();
	});
});

/**
 * The window now loads while the engine is still starting, so "the engine is
 * not there yet" is an ordinary launch rather than only a crash. Two things
 * have to be true for that to be an improvement instead of a regression: the
 * poll that ends the disconnected state has to be quick, and the queries that
 * gave up during it have to be told to try again. Nothing else in the app
 * notices a late engine - every other query settles after two retries, and
 * `refetchOnReconnect` fires on the browser's online/offline event, which
 * localhost never changes.
 */
describe("useHealthQuery - an engine that arrives after the window", () => {
	function makeClient() {
		// `retry` is set by the hook itself, so it cannot be turned off here - but
		// the delay between those retries can, and the default backoff is longer
		// than `waitFor` will wait for the error state it produces.
		return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	}

	function wrapperFor(client: QueryClient) {
		return function Wrapper({ children }: { children: ReactNode }) {
			return createElement(QueryClientProvider, { client }, children);
		};
	}

	it("refetches everything once the engine answers after a failed poll", async () => {
		const client = makeClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		// Twice: the hook sets `retry: 1`, so one rejection is absorbed by the
		// retry and never reaches an error state.
		getHealth
			.mockRejectedValueOnce(new Error("Network error: fetch failed"))
			.mockRejectedValueOnce(new Error("Network error: fetch failed"));
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		// The query's own state, not the store's: the store starts on `starting`,
		// so waiting on it would pass before the poll had failed at all.
		await waitFor(() => expect(result.current.isError).toBe(true));
		// A failure this early in the session is a cold start, not a dead engine -
		// it records no reason, and the case below is where the reason appears.
		expect(useEngineStore.getState().engineStatus).toBe("starting");
		expect(invalidate).not.toHaveBeenCalled();

		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("does not refetch on a launch where no poll ever failed", async () => {
		// The engine coming up is not by itself news: on an ordinary launch every
		// query is already in flight, and invalidating here would be a second
		// boot's worth of requests for nothing.
		const client = makeClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		getHealth.mockResolvedValue({ status: "ok", version: "1.0.0", workers: 8 });

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));

		await act(async () => {
			await result.current.refetch();
		});

		expect(invalidate).not.toHaveBeenCalled();
	});

	it("polls hard while disconnected and cheaply once connected", () => {
		expect(healthPollIntervalMs("error")).toBe(TIMING.HEALTH_RECONNECT_POLL_INTERVAL_MS);
		expect(healthPollIntervalMs("success")).toBe(TIMING.HEALTH_CHECK_INTERVAL_MS);
		expect(healthPollIntervalMs("pending")).toBe(TIMING.HEALTH_CHECK_INTERVAL_MS);
		// The whole point of the fast branch: a launch must not sit disconnected
		// for the connected cadence after the engine is already serving.
		expect(TIMING.HEALTH_RECONNECT_POLL_INTERVAL_MS).toBeLessThan(
			TIMING.HEALTH_CHECK_INTERVAL_MS
		);
	});
});

/**
 * A refused connection is the same transport error on a cold start and on a
 * dead engine, so the poll cannot tell them apart - only its place in the
 * session can (#1164). Before this, both wrote "Disconnected" and a raw
 * transport string into a strip the user was looking at three seconds into an
 * ordinary launch.
 */
describe("useHealthQuery - a cold start is not a dead engine", () => {
	function clientWithFastRetries() {
		// `retry` belongs to the hook; only the delay between the attempts can be
		// flattened here, and the default backoff outlasts `waitFor`.
		return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	}

	function wrapperFor(client: QueryClient) {
		return function Wrapper({ children }: { children: ReactNode }) {
			return createElement(QueryClientProvider, { client }, children);
		};
	}

	it("classifies a failed poll by how long the engine has been coming up", () => {
		// The decision itself, without a clock: the hook feeds it both times, and
		// zero stands in for the moment the window opened.
		expect(engineStatusAfterFailedPoll(0, 0)).toBe("starting");
		expect(engineStatusAfterFailedPoll(0, TIMING.ENGINE_STARTUP_GRACE_MS - 1)).toBe("starting");
		expect(engineStatusAfterFailedPoll(0, TIMING.ENGINE_STARTUP_GRACE_MS)).toBe("unreachable");
		// No window open means nothing is coming up: an engine that answered proved
		// it could serve, so its silence is news immediately - the grace is for
		// engines that have not finished starting.
		expect(engineStatusAfterFailedPoll(null, 0)).toBe("unreachable");
	});

	it("records no reason while the launch is inside the grace window", async () => {
		const client = clientWithFastRetries();
		getHealth.mockRejectedValue(new Error("Network error: fetch failed"));

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(useEngineStore.getState().engineStatus).toBe("starting");
		// The Dock's affordance hangs off this being null. A string here is a red
		// flag and a transport error on a launch that is going fine.
		expect(useEngineStore.getState().engineError).toBeNull();
	});

	it("turns starting into unreachable once the window closes, with the reason", async () => {
		const client = clientWithFastRetries();
		getHealth.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:9876"));

		// Mount at a known zero, then age the session past the budget. Only
		// `Date.now` moves: the poll's own cadence is a timer, and the transition
		// rides the next failed poll rather than a clock the hook watches - which
		// is also why the rejection is one reused `Error` object. Nothing about
		// the failure changes when the window closes; only its place in the
		// session does, and the poll after it is what re-reads that.
		const mountedAt = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(mountedAt);

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("starting"));

		now.mockReturnValue(mountedAt + TIMING.ENGINE_STARTUP_GRACE_MS + 1);
		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));
		expect(useEngineStore.getState().engineError).toContain("ECONNREFUSED");
		now.mockRestore();
	});

	it("calls an engine that answered and then stopped unreachable at once", async () => {
		// No grace on this path: the grace exists for a process that has not
		// finished starting, and this one finished long enough ago to serve a poll.
		const client = clientWithFastRetries();
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));

		getHealth.mockRejectedValue(new Error("socket hang up"));
		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));
		expect(useEngineStore.getState().engineError).toContain("socket hang up");
	});

	it("tells the user once when the engine they were using stops answering", async () => {
		// The transition, not the state. A failing poll is on the fast cadence, so
		// re-posting on each one would put a notification on screen every few
		// hundred milliseconds - drop the `previousStatus` guard in health.ts and
		// the second assertion here fails.
		const client = clientWithFastRetries();
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));

		getHealth.mockRejectedValue(new Error("socket hang up"));
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));

		expect(mockNotifyPost).toHaveBeenCalledWith({
			kind: NOTIFY_KINDS.engineLost,
			title: "Vayu's engine stopped responding",
			body: expect.stringContaining("socket hang up"),
		});

		mockNotifyPost.mockClear();
		await act(async () => {
			await result.current.refetch();
		});

		expect(mockNotifyPost).not.toHaveBeenCalled();
	});

	it("says nothing while a launch is still inside the start window", async () => {
		// A cold start is not a lost engine, and the app itself says so - the
		// status is "starting" and the Dock shows it. Notifying here would tell
		// every user their engine died once per launch.
		const client = clientWithFastRetries();
		getHealth.mockRejectedValue(new Error("Network error: fetch failed"));

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(result.current.isError).toBe(true));

		expect(useEngineStore.getState().engineStatus).toBe("starting");
		expect(mockNotifyPost).not.toHaveBeenCalled();
	});

	it("holds the window open across a poll that never succeeded", async () => {
		// The window is opened once, on mount, and a launch's repeated failures
		// must not consume it: only the clock closes it. Without this, a second
		// failed poll inside the budget could still read `unreachable`.
		const client = clientWithFastRetries();
		getHealth.mockRejectedValue(new Error("Network error: fetch failed"));

		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("starting"));

		await act(async () => {
			await result.current.refetch();
		});

		expect(useEngineStore.getState().engineStatus).toBe("starting");
		expect(useEngineStore.getState().engineStartWindow).not.toBeNull();
	});

	it("waits exactly as long as the main process waits for the same engine", () => {
		// Two files that share no module graph (`tsconfig.json` includes `src`,
		// `tsconfig.node.json` includes `electron`), asking the same question from
		// either side of the process boundary: is this engine still starting, or is
		// something wrong? A renderer that gave up first would put a failure on
		// screen while the sidecar was still waiting patiently.
		const constants = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "..", "electron", "constants.ts"),
			"utf8"
		);
		// A guard that scanned an empty string passed for weeks elsewhere here.
		expect(constants).toContain("ENGINE_HEALTH_POLL_BUDGET_MS");

		const budget = /ENGINE_HEALTH_POLL_BUDGET_MS\s*=\s*(\d+)/.exec(constants)?.[1];
		expect(Number(budget)).toBe(TIMING.ENGINE_STARTUP_GRACE_MS);
	});
});

/**
 * A restart is a cold start too (#1227).
 *
 * `useEngineRestart` kills the running engine and spawns a fresh one that
 * repeats the whole startup housekeeping, with the port down for all of it - so
 * the poll's failures during that window describe an engine coming up, not one
 * that died. The seam between the two paths is the store's start window: the
 * restart opens it, and this is the half that proves the poll reads it. The
 * other half - that the restart path really does open it - is
 * `Dock.pending-restart.test.tsx`, and both together are asserted end to end in
 * `Dock.restart-status.test.tsx`.
 */
describe("useHealthQuery - a restart is a cold start", () => {
	function clientWithFastRetries() {
		return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
	}

	function wrapperFor(client: QueryClient) {
		return function Wrapper({ children }: { children: ReactNode }) {
			return createElement(QueryClientProvider, { client }, children);
		};
	}

	/**
	 * A refusal per attempt, as the transport really delivers them.
	 *
	 * These cases turn on two *consecutive* failed polls reading differently, and
	 * the hook re-reads a failure when the query hands it a new one. One reused
	 * `Error` is one unchanged value, so the second poll would never be classified
	 * at all - a property of the fixture, not of the engine.
	 */
	function rejectWith(message: string) {
		getHealth.mockImplementation(() => Promise.reject(new Error(message)));
	}

	/** Connect, then hand back the hook with the launch's own window spent. */
	async function connected(client: QueryClient) {
		getHealth.mockResolvedValueOnce({ status: "ok", version: "1.0.0", workers: 8 });
		const { result } = renderHook(() => useHealthQuery(), { wrapper: wrapperFor(client) });
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("connected"));
		expect(useEngineStore.getState().engineStartWindow).toBeNull();
		return result;
	}

	it("calls the silence a start when the app itself asked for the restart", async () => {
		const client = clientWithFastRetries();
		const result = await connected(client);

		// What `useEngineRestart` does before it invokes the IPC.
		useEngineStore.getState().openEngineStartWindow(Date.now());
		rejectWith("connect ECONNREFUSED 127.0.0.1:9876");
		await act(async () => {
			await result.current.refetch();
		});

		// Reverting the re-open reddens this: the poll would see an engine that
		// answered and stopped, and paint the failure the user themselves asked for.
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("starting"));
		// The Dock's tooltip hangs off this being null.
		expect(useEngineStore.getState().engineError).toBeNull();
	});

	it("still gives up on a restart whose engine never comes back", async () => {
		const client = clientWithFastRetries();
		const result = await connected(client);

		const restartedAt = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(restartedAt);
		useEngineStore.getState().openEngineStartWindow(restartedAt);
		rejectWith("connect ECONNREFUSED 127.0.0.1:9876");
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("starting"));

		// Same budget as a cold launch, spent from the restart rather than from
		// the session's start.
		now.mockReturnValue(restartedAt + TIMING.ENGINE_STARTUP_GRACE_MS + 1);
		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));
		expect(useEngineStore.getState().engineError).toContain("ECONNREFUSED");
		now.mockRestore();
	});

	it("goes back to owing a reason once a restart is reported failed", async () => {
		const client = clientWithFastRetries();
		const result = await connected(client);

		useEngineStore.getState().openEngineStartWindow(Date.now());
		rejectWith("socket hang up");
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("starting"));

		// What `useEngineRestart` does when the main process reports failure:
		// nothing is coming up, so the strip must not sit on "Starting…".
		useEngineStore.getState().closeEngineStartWindow();
		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().engineStatus).toBe("unreachable"));
		expect(useEngineStore.getState().engineError).toContain("socket hang up");
	});
});
