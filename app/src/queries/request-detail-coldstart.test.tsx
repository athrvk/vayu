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
 * A restored tab must find its request on a cold start - in one lookup.
 *
 * `openTabs` is persisted, so on launch every restored request tab calls
 * `useRequestQuery` immediately. It now hits `GET /requests/:id` directly, so
 * there is no window to lose: the engine either returns the request or a
 * definitive 404. The old implementation scanned every collection's list
 * (the N+1 fan-out) and, worse, only *read* the cache - so on a cold start it
 * threw, and `staleTime: Infinity` parked that error permanently.
 *
 * The load-bearing behaviour these tests lock is the error split: a 404 is a
 * genuine deletion (`RequestNotFoundError`), and everything else - a 5xx, an
 * unreachable engine - is a transport failure that must NOT be mistaken for one.
 * That is the bug the old `.catch(() => [])` scan could not avoid.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRequestQuery, isRequestNotFound } from "./collections";
import { queryKeys } from "./keys";
import { ApiError } from "@/services";

const getRequest = vi.fn();

// Only apiService is mocked; ApiError stays the real class from ./http-client,
// so `error instanceof ApiError` in the hook matches what we throw here.
vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: (...a: unknown[]) => getRequest(...a),
	},
}));

const REQ = {
	id: "req_2",
	collectionId: "col_b",
	name: "Get user",
	method: "GET",
	url: "https://example.test/user",
};

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	getRequest.mockReset();
});

describe("cold start, nothing cached", () => {
	it("finds the request in a single lookup", async () => {
		getRequest.mockResolvedValue(REQ);
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.data).toMatchObject({ id: "req_2", name: "Get user" });
		expect(result.current.isError).toBe(false);
		expect(getRequest).toHaveBeenCalledWith("req_2");
	});
});

describe("when the request really is gone", () => {
	it("errors as a RequestNotFoundError, so the pane can say so honestly", async () => {
		getRequest.mockRejectedValue(new ApiError(404, "not_found", "gone"));
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_gone"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeUndefined();
		expect(isRequestNotFound(result.current.error)).toBe(true);
	});

	it("does not retry a definitive 404", async () => {
		getRequest.mockRejectedValue(new ApiError(404, "not_found", "gone"));
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_gone"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		// A 404 is final - one call, no retry storm.
		expect(getRequest).toHaveBeenCalledTimes(1);
	});
});

describe("a transport failure is not a deletion", () => {
	it("does not turn a 5xx into RequestNotFoundError", async () => {
		getRequest.mockRejectedValue(new ApiError(500, "engine_error", "boom"));
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		// A non-404 retries a bounded number of times before settling.
		await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 2000 });
		// The bug fix: a 5xx must stay a transport failure, so callers like
		// DesignRunView do not replay an orphan's recorded headers by mistake.
		expect(isRequestNotFound(result.current.error)).toBe(false);
	});

	it("does not turn an unreachable engine into RequestNotFoundError", async () => {
		getRequest.mockRejectedValue(new Error("Network error: connection refused"));
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 2000 });
		expect(isRequestNotFound(result.current.error)).toBe(false);
	});
});

describe("cache and gating", () => {
	it("serves an already-cached request without a network call", async () => {
		const client = makeClient();
		client.setQueryData(queryKeys.requests.detail("req_2"), REQ);

		const { result } = renderHook(() => useRequestQuery("req_2"), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.data).toBeTruthy());
		expect(getRequest).not.toHaveBeenCalled();
	});

	it("is disabled without an id", () => {
		const client = makeClient();
		const { result } = renderHook(() => useRequestQuery(null), {
			wrapper: wrapper(client),
		});
		expect(result.current.fetchStatus).toBe("idle");
		expect(getRequest).not.toHaveBeenCalled();
	});
});
