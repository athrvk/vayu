/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shared retry policy.
 *
 * `retry: 2` meant a deterministic 4xx was asked three times before the caller
 * saw the error: a lookup for a deleted row fired three identical GETs and the
 * pane sat on a spinner through all of them. Only `requestDetailOptions` had
 * opted out, with its own predicate.
 *
 * The range check is deliberate rather than `statusCode < 500`: `ApiError` is
 * only thrown with a real HTTP status (`http-client.ts` turns a timeout or a
 * dead socket into a plain `Error`), so anything outside 4xx is either a server
 * fault or something unclassified, and both are worth retrying.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	shouldRetryQuery,
	shouldRetryMutation,
	queryRetryDelay,
	queryClient as appQueryClient,
} from "./query-client";
import { QUERY_CACHE } from "@/config/cache";
import { TIMING } from "@/config/timing";
import { ApiError, EngineUnreachableError } from "@/services/http-client";
import { useEngineStore } from "@/stores/engine-store";

const apiError = (status: number) => new ApiError(status, "CODE", `HTTP ${status}`);

describe("shouldRetryQuery", () => {
	it("does not retry a 404 - a deleted row answers the same way every time", () => {
		expect(shouldRetryQuery(0, apiError(404))).toBe(false);
	});

	it("does not retry any other 4xx", () => {
		for (const status of [400, 401, 403, 409, 422, 499]) {
			expect(shouldRetryQuery(0, apiError(status))).toBe(false);
		}
	});

	it("retries a 5xx up to the default budget", () => {
		expect(shouldRetryQuery(0, apiError(500))).toBe(true);
		expect(shouldRetryQuery(QUERY_CACHE.DEFAULT_QUERY_RETRY - 1, apiError(503))).toBe(true);
		expect(shouldRetryQuery(QUERY_CACHE.DEFAULT_QUERY_RETRY, apiError(500))).toBe(false);
	});

	it("retries a transport failure, which is not an ApiError at all", () => {
		// `http-client.ts` throws these for a timeout or an unreachable engine -
		// exactly the failures that do recover on their own.
		expect(shouldRetryQuery(0, new Error("Network error: fetch failed"))).toBe(true);
		expect(shouldRetryQuery(0, new Error("Request timeout"))).toBe(true);
	});

	it("keeps the budget it always had for retryable errors", () => {
		expect(QUERY_CACHE.DEFAULT_QUERY_RETRY).toBe(2);
	});
});

/**
 * The mutation default used to be a bare count with no error-type awareness -
 * a 413 whose body the engine refused, or a 400, was retried once, re-sending
 * the same oversized or malformed payload for the same rejection.
 */
describe("shouldRetryMutation", () => {
	it("does not retry a 413 - re-sending the same oversized body changes nothing", () => {
		expect(shouldRetryMutation(0, apiError(413))).toBe(false);
	});

	it("does not retry any other 4xx", () => {
		for (const status of [400, 401, 403, 409, 422]) {
			expect(shouldRetryMutation(0, apiError(status))).toBe(false);
		}
	});

	it("retries a transport failure once, the same as before", () => {
		expect(shouldRetryMutation(0, new Error("Network error: fetch failed"))).toBe(true);
		expect(shouldRetryMutation(QUERY_CACHE.DEFAULT_MUTATION_RETRY, new Error("timeout"))).toBe(
			false
		);
	});

	it("retries a 5xx up to the mutation budget", () => {
		expect(shouldRetryMutation(0, apiError(500))).toBe(true);
		expect(shouldRetryMutation(QUERY_CACHE.DEFAULT_MUTATION_RETRY, apiError(500))).toBe(false);
	});
});

/**
 * A query racing an engine that is still starting.
 *
 * The window paints before the engine listens (#1144), so every query mounted
 * at first paint - the collection tree, the Launcher's runs, a restored tab's
 * request - is refused. On the old budget they settled into "Couldn't reach
 * Vayu's engine" panes while the Dock beside them said "Starting…", until the
 * health poll's reconnect refetch replaced them: a flash of failure on an
 * ordinary launch. Driven through a client built from the app's own defaults,
 * so the wiring is under test and not only the predicates.
 *
 * Mutation-check: drop the `isEngineStartFailure` term from `shouldRetryQuery`
 * and the first case settles into `error`; drop `retryDelay` from the defaults
 * and data lags the engine by the exponential backoff, failing the same case.
 */
describe("a query racing an engine that is still starting", () => {
	const refused = () =>
		new EngineUnreachableError("Couldn't reach Vayu's engine (Failed to fetch).");

	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});

	afterEach(() => {
		vi.useRealTimers();
		useEngineStore.setState({ engineStartWindow: null });
	});

	function observe(queryFn: () => Promise<string>) {
		const client = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
		const observer = new QueryObserver(client, { queryKey: ["probe"], queryFn });
		const statuses: string[] = [];
		const unsubscribe = observer.subscribe((result) => statuses.push(result.status));
		return { observer, statuses, unsubscribe };
	}

	it("stays loading past the old budget and loads as soon as the engine answers", async () => {
		useEngineStore.setState({ engineStartWindow: Date.now() });
		let engineUp = false;
		const queryFn = vi.fn(async () => {
			if (!engineUp) throw refused();
			return "collections";
		});
		const { observer, statuses, unsubscribe } = observe(queryFn);

		// Well past the default budget's two retries (one second, then two).
		await vi.advanceTimersByTimeAsync(5_000);
		expect(queryFn.mock.calls.length).toBeGreaterThan(QUERY_CACHE.DEFAULT_QUERY_RETRY + 1);
		expect(observer.getCurrentResult().status).toBe("pending");

		engineUp = true;
		await vi.advanceTimersByTimeAsync(QUERY_CACHE.ENGINE_START_RETRY_DELAY_MS);
		expect(observer.getCurrentResult().data).toBe("collections");
		expect(statuses).not.toContain("error");
		unsubscribe();
	});

	it("still surfaces an engine that never arrives, when the start window runs out", async () => {
		useEngineStore.setState({ engineStartWindow: Date.now() });
		const { observer, unsubscribe } = observe(() => Promise.reject(refused()));

		await vi.advanceTimersByTimeAsync(TIMING.ENGINE_STARTUP_GRACE_MS - 1_000);
		expect(observer.getCurrentResult().status).toBe("pending");

		// The next refused attempt after expiry is the last: the count it has
		// run up is far past the budget it now answers to again.
		await vi.advanceTimersByTimeAsync(1_000 + QUERY_CACHE.ENGINE_START_RETRY_DELAY_MS);
		expect(observer.getCurrentResult().status).toBe("error");
		expect(observer.getCurrentResult().error).toBeInstanceOf(EngineUnreachableError);
		unsubscribe();
	});

	it("keeps the default budget for an engine that stopped with nothing starting", async () => {
		const queryFn = vi.fn(() => Promise.reject(refused()));
		const { observer, unsubscribe } = observe(queryFn);

		// One second, then two: the budget it always had.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(observer.getCurrentResult().status).toBe("error");
		expect(queryFn).toHaveBeenCalledTimes(QUERY_CACHE.DEFAULT_QUERY_RETRY + 1);
		unsubscribe();
	});

	it("keeps the default budget for an engine that answered, even mid-start", async () => {
		useEngineStore.setState({ engineStartWindow: Date.now() });
		const queryFn = vi.fn(() => Promise.reject(new ApiError(500, "internal", "boom")));
		const { observer, unsubscribe } = observe(queryFn);

		await vi.advanceTimersByTimeAsync(3_000);
		expect(observer.getCurrentResult().status).toBe("error");
		expect(queryFn).toHaveBeenCalledTimes(QUERY_CACHE.DEFAULT_QUERY_RETRY + 1);
		unsubscribe();
	});
});

describe("queryRetryDelay", () => {
	afterEach(() => {
		useEngineStore.setState({ engineStartWindow: null });
	});

	it("waits the short start delay for a refused connection while starting", () => {
		useEngineStore.setState({ engineStartWindow: Date.now() });
		expect(queryRetryDelay(5, new EngineUnreachableError("refused"))).toBe(
			QUERY_CACHE.ENGINE_START_RETRY_DELAY_MS
		);
		// An engine that answered is not waiting to arrive.
		expect(queryRetryDelay(1, new ApiError(503, "busy", "busy"))).toBe(2_000);
	});

	it("backs off as TanStack does otherwise: doubling from a second, capped at thirty", () => {
		const refused = new EngineUnreachableError("refused");
		expect(queryRetryDelay(0, refused)).toBe(1_000);
		expect(queryRetryDelay(1, refused)).toBe(2_000);
		expect(queryRetryDelay(10, refused)).toBe(30_000);
	});
});
