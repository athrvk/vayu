/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EngineClient, EngineTimeoutError } from "./engine-client.js";

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

describe("EngineClient.getEnvironment", () => {
	// The engine has no `GET /environments/:id` route (only the list). Hitting a
	// per-id path 404s, which silently broke variable resolution - so this pins
	// the client to the list endpoint + client-side filter.
	function listFetch(payload: unknown) {
		const calls: string[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return new Response(JSON.stringify(payload));
		}) as unknown as typeof fetch;
		return { fetchImpl, calls };
	}

	it("resolves a single environment from the list endpoint (not /environments/:id)", async () => {
		const { fetchImpl, calls } = listFetch([
			{ id: "env_1", name: "Dev", variables: { a: { value: "1", enabled: true } } },
			{ id: "env_2", name: "Prod", variables: {} },
		]);
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });

		const env = await client.getEnvironment("env_2");

		expect(calls).toEqual(["http://127.0.0.1:9876/environments"]);
		expect(calls[0]).not.toContain("/environments/env_2");
		expect(env).toMatchObject({ id: "env_2", name: "Prod" });
	});

	it("returns null when no environment matches", async () => {
		const { fetchImpl } = listFetch([{ id: "env_1", name: "Dev" }]);
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		await expect(client.getEnvironment("missing")).resolves.toBeNull();
	});
});

/**
 * `POST /execute` waits on a third-party server, bounded engine-side by the
 * user-configurable `defaultTimeout` (up to 300s). A flat client budget below
 * that aborts a request the engine goes on to complete - side effects sent, run
 * row written - so these pin the budget to the engine's own setting. Driven on
 * fake timers: the assertion is which budget was armed, never wall-clock.
 */
describe("EngineClient /execute abort budget", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * A fetch that answers `GET /config` from `entries` (or rejects when it is
	 * null, standing in for an unreachable or slow config) and leaves every other
	 * call hanging until its signal aborts.
	 */
	function executeFetch(entries: Array<Record<string, string>> | null) {
		const urls: string[] = [];
		const fetchImpl = vi.fn((url: string | URL | Request, opts?: RequestInit) => {
			urls.push(String(url));
			if (String(url).endsWith("/config")) {
				return entries
					? Promise.resolve(new Response(JSON.stringify({ entries })))
					: Promise.reject(new TypeError("fetch failed"));
			}
			return new Promise<Response>((_resolve, reject) => {
				const abort = () =>
					reject(new DOMException("The operation was aborted.", "AbortError"));
				// Real fetch rejects at once for a signal that is already aborted;
				// only listening for the event would hang here instead.
				if (opts?.signal?.aborted) abort();
				else opts?.signal?.addEventListener("abort", abort);
			});
		}) as unknown as typeof fetch;
		return { fetchImpl, urls };
	}

	/** Start an execute and let the config probe resolve before time advances. */
	async function startExecute(
		entries: Array<Record<string, string>> | null,
		payload: Record<string, unknown> = { url: "https://slow.example.com" }
	) {
		vi.useFakeTimers();
		const { fetchImpl, urls } = executeFetch(entries);
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		let settled = false;
		const pending = client.executeRequest(payload).catch((err: unknown) => {
			settled = true;
			throw err;
		});
		// Swallow the rejection until a test awaits it - the budget only arms
		// after the probe resolves, which needs the microtask queue to drain.
		pending.catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		return { pending, urls, settled: () => settled };
	}

	it("outlives the engine's configured defaultTimeout, and reports the budget when it expires", async () => {
		const { pending, settled } = await startExecute([
			{ key: "defaultTimeout", value: "120000" },
		]);

		// A flat 35s budget would have aborted here, mid-request.
		await vi.advanceTimersByTimeAsync(129_000);
		expect(settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(2_000);
		await expect(pending).rejects.toBeInstanceOf(EngineTimeoutError);
		await expect(pending).rejects.toMatchObject({ timeoutMs: 130_000 });
	});

	it("falls back to the engine's 300s ceiling when the config cannot be read", async () => {
		const { pending, settled } = await startExecute(null);

		await vi.advanceTimersByTimeAsync(309_000);
		expect(settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(2_000);
		await expect(pending).rejects.toMatchObject({ timeoutMs: 310_000 });
	});

	it("takes the payload's own timeout when it exceeds the configured default", async () => {
		const { pending } = await startExecute([{ key: "defaultTimeout", value: "120000" }], {
			url: "https://slow.example.com",
			timeout: 200_000,
		});

		await vi.advanceTimersByTimeAsync(211_000);
		await expect(pending).rejects.toMatchObject({ timeoutMs: 210_000 });
	});

	it("leaves engine-local calls on the flat budget and probes no config for them", async () => {
		vi.useFakeTimers();
		const { fetchImpl, urls } = executeFetch([{ key: "defaultTimeout", value: "120000" }]);
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });

		const pending = client.listCollections();
		pending.catch(() => {});
		await vi.advanceTimersByTimeAsync(36_000);

		await expect(pending).rejects.toMatchObject({ timeoutMs: 35_000 });
		expect(urls).toEqual(["http://127.0.0.1:9876/collections"]);
	});

	it("reports a caller's cancellation as an abort, not as a timeout", async () => {
		const { fetchImpl } = executeFetch([{ key: "defaultTimeout", value: "120000" }]);
		const client = new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
		const controller = new AbortController();

		const pending = client.executeRequest(
			{ url: "https://slow.example.com" },
			controller.signal
		);
		pending.catch(() => {});
		await Promise.resolve();
		controller.abort();

		await expect(pending).rejects.not.toBeInstanceOf(EngineTimeoutError);
		await expect(pending).rejects.toThrow(/abort/i);
	});
});
