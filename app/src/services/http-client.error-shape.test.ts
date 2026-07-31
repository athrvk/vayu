/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the user is shown when an engine call fails (issue #173).
 *
 * The regression this closes is not a wrong status code - those always worked -
 * it is a *dropped message*. The engine writes "Missing required field: name";
 * the client used to read `errorData.error.message` only, which on the flat
 * `{"error": "..."}` body the CRUD routes emitted is `undefined`, so the save
 * dialog said "HTTP 400: Bad Request" and the reason never reached anyone.
 *
 * Every case here therefore asserts the **text** on the thrown ApiError.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { httpClient, ApiError } from "./http-client";

/** A fetch that answers once with the given status and body. */
function respondWith(status: number, body: unknown, ok = false) {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok,
			status,
			statusText: status === 400 ? "Bad Request" : "Not Found",
			json: async () => JSON.parse(text),
		})
	);
}

async function failedGet(): Promise<ApiError> {
	try {
		await httpClient.get("/collections");
	} catch (e) {
		return e as ApiError;
	}
	throw new Error("expected the request to reject");
}

afterEach(() => vi.unstubAllGlobals());

describe("httpClient error bodies", () => {
	it("surfaces the engine's message and code from the nested shape", async () => {
		respondWith(400, {
			error: { code: "bad_request", message: "Missing required field: name" },
		});

		const error = await failedGet();
		expect(error).toBeInstanceOf(ApiError);
		expect(error.message).toBe("Missing required field: name");
		expect(error.errorCode).toBe("bad_request");
		expect(error.statusCode).toBe(400);
	});

	it("keeps a route's own code rather than flattening it to the status default", async () => {
		respondWith(400, {
			error: { code: "invalid_config", message: "'workers' must be at most 256 (got 9999)" },
		});

		const error = await failedGet();
		expect(error.errorCode).toBe("invalid_config");
		expect(error.message).toContain("9999");
	});

	// The sidecar and the app are not updated atomically, so a new app can meet
	// an engine that predates the migration. Its message must still be read.
	it("still reads the legacy flat body a pre-#173 engine sends", async () => {
		respondWith(404, { error: "Collection not found" });

		const error = await failedGet();
		expect(error.message).toBe("Collection not found");
		expect(error.errorCode).toBe("UNKNOWN_ERROR");
	});

	it("falls back to the status line when the body carries no message", async () => {
		respondWith(400, {});

		const error = await failedGet();
		expect(error.message).toBe("HTTP 400: Bad Request");
	});

	it("falls back to the status line when the body is not JSON at all", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				statusText: "Bad Request",
				json: async () => {
					throw new SyntaxError("Unexpected token <");
				},
			})
		);

		const error = await failedGet();
		expect(error.message).toBe("HTTP 400: Bad Request");
	});

	it("keeps the raw body on the error so a caller can read extra detail", async () => {
		respondWith(400, {
			error: { code: "bad_request", message: "Duplicate tempId 'c1'", item: "c1" },
		});

		const error = await failedGet();
		expect((error.response as { error: { item: string } }).error.item).toBe("c1");
	});
});
