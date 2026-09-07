/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Belt and braces against Chromium's disk cache (issue #1507).
 *
 * The engine answers every response with `Cache-Control: no-store`, but a dev
 * build can be talking to an older engine, or a future route could forget the
 * header - so the client asks `fetch` itself never to cache, on every call it
 * makes.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { httpClient } from "./http-client";

function fetchMock(response: Record<string, unknown>) {
	const mock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal("fetch", mock);
	return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("httpClient no-store", () => {
	it("passes cache: no-store on a plain request", async () => {
		const mock = fetchMock({ ok: true, status: 200, json: async () => ({}) });

		await httpClient.get("/collections");

		const [, init] = mock.mock.calls[0] as [string, RequestInit];
		expect(init.cache).toBe("no-store");
	});

	it("passes cache: no-store on a body-carrying request", async () => {
		const mock = fetchMock({ ok: true, status: 200, json: async () => ({}) });

		await httpClient.post("/collections", { name: "x" });

		const [, init] = mock.mock.calls[0] as [string, RequestInit];
		expect(init.cache).toBe("no-store");
	});

	it("passes cache: no-store on a streamed request", async () => {
		const mock = fetchMock({
			ok: true,
			status: 200,
			json: async () => ({ done: true }),
			headers: { get: () => "application/json" },
			body: null,
		});

		const iterator = httpClient.stream("/import/fetch", { url: "https://x" });
		await iterator.next();

		const [, init] = mock.mock.calls[0] as [string, RequestInit];
		expect(init.cache).toBe("no-store");
	});
});
