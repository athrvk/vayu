/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { EngineClient } from "./engine-client.js";

/** A fetch that never resolves on its own but rejects when its signal aborts. */
function abortableFetch(): { fetchImpl: typeof fetch; seen: () => AbortSignal | undefined } {
	let seen: AbortSignal | undefined;
	const fetchImpl = vi.fn((_url: string | URL | Request, opts?: RequestInit) => {
		seen = opts?.signal ?? undefined;
		return new Promise<Response>((_resolve, reject) => {
			opts?.signal?.addEventListener("abort", () =>
				reject(new DOMException("The operation was aborted.", "AbortError"))
			);
		});
	}) as unknown as typeof fetch;
	return { fetchImpl, seen: () => seen };
}

describe("EngineClient cancellation", () => {
	it("aborts the underlying fetch when the caller's signal aborts", async () => {
		const { fetchImpl } = abortableFetch();
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		const controller = new AbortController();

		const pending = client.health(controller.signal);
		controller.abort();

		await expect(pending).rejects.toThrow(/abort/i);
	});

	it("passes a combined signal to fetch (caller + internal timeout)", async () => {
		const { fetchImpl, seen } = abortableFetch();
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		const controller = new AbortController();

		const pending = client.getRunReport("run_1", controller.signal);
		expect(seen()).toBeInstanceOf(AbortSignal);
		expect(seen()?.aborted).toBe(false);

		controller.abort();
		await expect(pending).rejects.toThrow();
	});

	it("still works without a caller signal (timeout controller only)", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ status: "ok" }))
		) as unknown as typeof fetch;
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		await expect(client.health()).resolves.toMatchObject({ status: "ok" });
	});
});
