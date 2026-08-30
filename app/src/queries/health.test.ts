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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getHealth = vi.fn();
vi.mock("@/services/api", () => ({ apiService: { getHealth: () => getHealth() } }));

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useHealthQuery, healthPollIntervalMs } from "./health";
import { useEngineStore } from "@/stores";
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
	useEngineStore.setState({ isEngineConnected: false, engineError: null, recovery: null });
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

		await waitFor(() => expect(useEngineStore.getState().isEngineConnected).toBe(true));
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
		// The query's own state, not the store's: the store starts disconnected,
		// so waiting on it would pass before the poll had failed at all.
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(useEngineStore.getState().engineError).toContain("Network error");
		expect(invalidate).not.toHaveBeenCalled();

		await act(async () => {
			await result.current.refetch();
		});

		await waitFor(() => expect(useEngineStore.getState().isEngineConnected).toBe(true));
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
		await waitFor(() => expect(useEngineStore.getState().isEngineConnected).toBe(true));

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
