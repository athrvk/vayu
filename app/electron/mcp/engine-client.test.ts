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

/**
 * The budgeted stream read (issue #575). `tools/call` is request/response, so
 * what matters is not that events arrive but that a read which stopped short
 * says which bound stopped it - the disclosure the tool's result rests on.
 */
describe("EngineClient.consumeStreamEvents", () => {
	/** A fetch answering one SSE body, delivered as the given chunks. */
	function streamingFetch(chunks: string[], status = 200): typeof fetch {
		return vi.fn(() =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							const encoder = new TextEncoder();
							for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
							controller.close();
						},
					}),
					{ status, headers: { "content-type": "text/event-stream" } }
				)
			)
		) as unknown as typeof fetch;
	}

	const frame = (event: string, data: string, id: number) =>
		`id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;

	function client(fetchImpl: typeof fetch) {
		return new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });
	}

	it("collects message frames and reports the stream's own ending", async () => {
		const result = await client(
			streamingFetch([
				frame("open", '{"statusCode":200}', 0),
				frame("message", '{"event":"tick","data":"1"}', 1),
				frame("message", '{"event":"tick","data":"2"}', 2),
				frame("complete", '{"reason":"completed","totalEvents":2}', 3),
			])
		).consumeStreamEvents("run_s");

		// `open` is the response, not an event - the caller already has it.
		expect(result.events).toEqual([
			{ event: "tick", data: "1" },
			{ event: "tick", data: "2" },
		]);
		expect(result.completed).toBe(true);
		expect(result.capReached).toBe(false);
		expect(result.endReason).toBe("completed");
		expect(result.totalEvents).toBe(2);
	});

	it("stops at the event cap and says the stream did not end", async () => {
		const result = await client(
			streamingFetch([
				frame("message", '{"n":1}', 0),
				frame("message", '{"n":2}', 1),
				frame("message", '{"n":3}', 2),
				frame("complete", '{"reason":"completed","totalEvents":3}', 3),
			])
		).consumeStreamEvents("run_s", 2);

		expect(result.events).toHaveLength(2);
		expect(result.capReached).toBe(true);
		// The distinction the whole disclosure rests on: this read ended, the
		// stream did not, and `totalEvents` was never reached to be reported.
		expect(result.completed).toBe(false);
		expect(result.totalEvents).toBeUndefined();
	});

	it("assembles a frame split across chunks", async () => {
		const result = await client(
			streamingFetch(['id: 0\nevent: message\ndata: {"ev', 'ent":"tick"}\n\n'])
		).consumeStreamEvents("run_s");
		expect(result.events).toEqual([{ event: "tick" }]);
	});

	it("drops a malformed frame rather than failing the read", async () => {
		const result = await client(
			streamingFetch([
				frame("message", "not json", 0),
				frame("message", '{"event":"tick"}', 1),
				frame("complete", '{"reason":"completed"}', 2),
			])
		).consumeStreamEvents("run_s");
		expect(result.events).toEqual([{ event: "tick" }]);
		expect(result.completed).toBe(true);
	});

	it("returns what it read when the budget expires mid-stream", async () => {
		// A body that delivers one event and then never ends, so only the budget
		// can stop the read. The signal errors the stream the way a real fetch
		// does - without that, an aborted read simply hangs and this test would
		// be measuring the runner's timeout rather than the budget.
		const fetchImpl = vi.fn((_url: string | URL | Request, opts?: RequestInit) =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(frame("message", '{"n":1}', 0))
							);
							opts?.signal?.addEventListener("abort", () =>
								controller.error(
									new DOMException("The operation was aborted.", "AbortError")
								)
							);
						},
					}),
					{ status: 200 }
				)
			)
		) as unknown as typeof fetch;

		const result = await client(fetchImpl).consumeStreamEvents("run_s", 50, 60);
		expect(result.events).toEqual([{ n: 1 }]);
		expect(result.completed).toBe(false);
		expect(result.capReached).toBe(false);
	});

	it("throws an engine error rather than reporting an empty stream", async () => {
		await expect(
			client(streamingFetch(["nope"], 404)).consumeStreamEvents("run_gone")
		).rejects.toThrow(/404/);
	});
});

/*
 * Run housekeeping (#755). What these pin is the *URL*: the engine ignores a
 * filter it cannot parse and answers the unfiltered page, so a misspelled query
 * key here would look like "nothing matched" rather than like a bug.
 */
describe("EngineClient run housekeeping", () => {
	function recordingFetch(payload: unknown = { data: [], pagination: { total: 0 } }) {
		const calls: Array<{ url: string; method?: string; body?: string }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, opts?: RequestInit) => {
			calls.push({
				url: String(url),
				method: opts?.method,
				body: typeof opts?.body === "string" ? opts.body : undefined,
			});
			return new Response(JSON.stringify(payload));
		}) as unknown as typeof fetch;
		return { fetchImpl, calls };
	}

	const client = (fetchImpl: typeof fetch) =>
		new EngineClient({ baseUrl: "http://127.0.0.1:9876", fetchImpl });

	it("asks for the envelope even with no filters", async () => {
		// A request carrying no recognised param takes the route's legacy path,
		// which answers a bare array of full-snapshot rows - a different shape
		// than every reader here expects.
		const { fetchImpl, calls } = recordingFetch();
		await client(fetchImpl).listRuns();
		expect(calls[0].url).toBe("http://127.0.0.1:9876/runs?limit=100&offset=0");
	});

	it("sends every stated filter, and only those", async () => {
		const { fetchImpl, calls } = recordingFetch();
		await client(fetchImpl).listRuns({
			limit: 25,
			offset: 50,
			type: "load",
			status: "completed",
			requestId: "req 1",
			collectionId: "col_1",
			q: "checkout flow",
			baseline: false,
		});
		const url = new URL(calls[0].url);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "25",
			offset: "50",
			type: "load",
			status: "completed",
			requestId: "req 1",
			collectionId: "col_1",
			q: "checkout flow",
			baseline: "false",
		});
	});

	it("resolves a baseline through the same query builder", async () => {
		const { fetchImpl, calls } = recordingFetch();
		await client(fetchImpl).listBaselineRuns("req_1");
		const url = new URL(calls[0].url);
		expect(url.pathname).toBe("/runs");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			limit: "1",
			offset: "0",
			requestId: "req_1",
			baseline: "true",
		});
	});

	it("deletes and pins through the engine's own verbs", async () => {
		const { fetchImpl, calls } = recordingFetch({ message: "Run deleted successfully" });
		const engine = client(fetchImpl);
		await engine.deleteRun("run_1");
		await engine.setRunBaseline("run_1", true);
		expect(calls[0]).toMatchObject({
			url: expect.stringContaining("/runs/run_1"),
			method: "DELETE",
		});
		expect(calls[1]).toMatchObject({
			url: "http://127.0.0.1:9876/runs/run_1/baseline",
			method: "PUT",
			body: JSON.stringify({ baseline: true }),
		});
	});

	it("pages the three per-run reads on their own paths", async () => {
		const { fetchImpl, calls } = recordingFetch();
		const engine = client(fetchImpl);
		await engine.getRunSamples("run_1", 25, 0);
		await engine.getRunTimeSeries("run_1", 100, 100);
		await engine.getRunMonitorSeries("run_1", 10, 5);
		expect(calls.map((c) => c.url)).toEqual([
			"http://127.0.0.1:9876/runs/run_1/samples?limit=25&offset=0",
			"http://127.0.0.1:9876/runs/run_1/metrics?limit=100&offset=100",
			"http://127.0.0.1:9876/runs/run_1/monitor?limit=10&offset=5",
		]);
	});
});
