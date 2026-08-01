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

import { describe, it, expect } from "vitest";
import { shouldRetryQuery } from "./query-client";
import { QUERY_CACHE } from "@/config/cache";
import { ApiError } from "@/services/http-client";

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
