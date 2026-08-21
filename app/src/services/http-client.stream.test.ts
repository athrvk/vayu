/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading an engine response that arrives as it happens (issue #882).
 *
 * The import dialog's URL tab used to freeze for the whole of an 8 MB download,
 * because `/import/fetch` could say nothing until libcurl had the entire body.
 * The engine now reports the arrival as a `text/event-stream`, and this is the
 * renderer's side of that: frames in, events out.
 *
 * Two things here are not decoration. **Frames split across chunks** - a
 * `ReadableStream` hands over whatever arrived, not whole SSE frames, and a
 * reader that assumed otherwise would drop or mangle every event that straddled
 * a TCP boundary; with 10 MB of content in the final frame that is a certainty,
 * not an edge case. And the **buffered fallback** - the app and the engine
 * sidecar are not updated together, so a new app can be talking to an engine
 * that has never heard of streaming and answers this request with plain JSON.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { httpClient, ApiError } from "./http-client";

/**
 * A `fetch` that answers with these body chunks as a `text/event-stream`.
 *
 * The body honours `init.signal`, because a real one does: `fetch` wires the
 * abort signal to the response stream, so aborting rejects a pending `read()`.
 * A mock that ignored it would let a reader with no timeout at all pass the
 * timeout test by hanging until vitest killed it.
 */
function streamOf(chunks: string[], delayMs = 0) {
	const encoder = new TextEncoder();
	/** Set when the consumer let go of the stream - a cancel, or an abort. */
	const released = { value: false };
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					init?.signal?.addEventListener("abort", () => {
						released.value = true;
						controller.error(new DOMException("Aborted", "AbortError"));
					});
					for (const chunk of chunks) {
						if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
						if (init?.signal?.aborted) return;
						controller.enqueue(encoder.encode(chunk));
					}
					controller.close();
				},
				cancel() {
					released.value = true;
				},
			});
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: new Headers({ "content-type": "text/event-stream" }),
				body,
			});
		})
	);
	return released;
}

/** A `fetch` that answers with a buffered JSON body - an engine without SSE. */
function jsonOf(payload: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => payload,
		})
	);
}

/** Everything the stream yielded, in order. */
async function drain(
	path = "/import/fetch",
	options?: { idleTimeout?: number; signal?: AbortSignal }
) {
	const seen = [];
	for await (const message of httpClient.stream(path, { url: "http://x" }, options)) {
		seen.push(message);
	}
	return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("httpClient.stream", () => {
	it("yields each event in order with its data parsed", async () => {
		streamOf([
			'event: progress\nid: 0\ndata: {"received":1024,"total":8192}\n\n',
			'event: result\nid: 1\ndata: {"content":"{}"}\n\n',
		]);

		expect(await drain()).toEqual([
			{ kind: "event", event: "progress", data: { received: 1024, total: 8192 } },
			{ kind: "event", event: "result", data: { content: "{}" } },
		]);
	});

	it("reassembles a frame that arrives split across chunks", async () => {
		// The split falls inside the JSON *and* inside the terminator, which is
		// what a 10 MB result frame does to every TCP boundary it crosses.
		streamOf(["event: result\nda", 'ta: {"content":"ab', 'c"}\n', "\n"]);

		expect(await drain()).toEqual([
			{ kind: "event", event: "result", data: { content: "abc" } },
		]);
	});

	it("skips keep-alive comments and carries an unnamed event as message", async () => {
		streamOf([": keep-alive\n\n", 'data: {"tick":1}\n\n']);

		// `: ` is SSE's comment, and an event with no `event:` line is named
		// `message` by the spec - not dropped for having no name.
		expect(await drain()).toEqual([{ kind: "event", event: "message", data: { tick: 1 } }]);
	});

	it("yields the whole body once when the engine answers with buffered JSON", async () => {
		jsonOf({ content: "{}", contentType: "application/json" });

		// One message, marked as what it is: an older engine that never heard of
		// streaming, answering the same request the way it always has. Reported
		// rather than retried - a second request would be a second download.
		expect(await drain()).toEqual([
			{ kind: "buffered", data: { content: "{}", contentType: "application/json" } },
		]);
	});

	it("throws the engine's message when the response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				statusText: "Bad Request",
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => ({ error: { code: "bad_request", message: "Invalid URL" } }),
			})
		);

		// A malformed request is refused before the stream opens, so it is still
		// a status - and has to read exactly like the buffered route's refusal.
		await expect(drain()).rejects.toThrow(ApiError);
		await expect(drain()).rejects.toThrow("Invalid URL");
	});

	it("gives up when nothing arrives for the idle timeout", async () => {
		streamOf(["never arrives"], 10_000); // Opens, then says nothing.

		await expect(drain("/import/fetch", { idleTimeout: 50 })).rejects.toThrow(
			"Request timeout"
		);
	});

	it("lets go of the stream when the consumer stops reading", async () => {
		// Closing the import dialog mid-download has to stop the download. The
		// engine abandons its transfer the moment its SSE sink refuses a write,
		// so what reaches it is this cancel - without it the engine reads the
		// remaining megabytes for a listener that has gone.
		const released = streamOf([
			'event: progress\ndata: {"received":1}\n\n',
			'event: progress\ndata: {"received":2}\n\n',
		]);

		for await (const message of httpClient.stream("/import/fetch", { url: "http://x" })) {
			expect(message.kind).toBe("event");
			break; // The dialog closed.
		}

		expect(released.value).toBe(true);
	});

	it("does not give up on a slow stream that keeps arriving", async () => {
		// The whole point of an idle timeout rather than a total one: four 100ms
		// gaps is 400ms of transfer, which a 300ms *total* budget would kill even
		// though nothing ever stalled. A 10 MB download is exactly this shape.
		streamOf(
			[
				'event: progress\ndata: {"n":1}\n\n',
				'event: progress\ndata: {"n":2}\n\n',
				'event: progress\ndata: {"n":3}\n\n',
				'event: result\ndata: {"n":4}\n\n',
			],
			100
		);

		const seen = await drain("/import/fetch", { idleTimeout: 300 });
		expect(seen).toHaveLength(4);
	});

	it("stops when the caller aborts, and says so as an abort", async () => {
		// Closing the import dialog has to stop the engine downloading, and the
		// only thing that reaches it is this cancel. Distinct from the idle
		// timeout on purpose: a deliberate abort surfaced as "Request timeout"
		// would leave a banner about a failure nobody had.
		const released = streamOf(["never arrives"], 10_000);
		const controller = new AbortController();

		const drained = drain("/import/fetch", { signal: controller.signal });
		controller.abort();

		await expect(drained).rejects.toThrow(
			expect.objectContaining({ name: "AbortError" }) as Error
		);
		expect(released.value).toBe(true);
	});

	it("still calls an idle stall a timeout, not an abort", async () => {
		// The other half of the same distinction. Both end in an AbortController,
		// so only the caller's own signal tells them apart.
		streamOf(["never arrives"], 10_000);

		await expect(
			drain("/import/fetch", { idleTimeout: 50, signal: new AbortController().signal })
		).rejects.toThrow("Request timeout");
	});

	it("does not open the request at all when the signal is already aborted", async () => {
		streamOf(['event: result\ndata: {"n":1}\n\n']);
		const controller = new AbortController();
		controller.abort();

		await expect(drain("/import/fetch", { signal: controller.signal })).rejects.toThrow(
			expect.objectContaining({ name: "AbortError" }) as Error
		);
	});
});
