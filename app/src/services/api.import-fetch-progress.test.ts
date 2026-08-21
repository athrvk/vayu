/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning a streamed `/import/fetch` back into one awaited answer (issue #882).
 *
 * The dialog wants a promise for the document and a callback for the bytes on
 * the way, not a loop over events - so this layer is where the stream becomes
 * both. Three things it has to get right and no test above it could catch:
 *
 * - **A caller with no `onProgress` must not stream at all.** `ref-bundler` and
 *   the spec re-fetch go through this same method and want the buffered body;
 *   opening a stream for them would change a contract they never asked about.
 * - **An `error` event has to throw.** It is the only shape a streamed failure
 *   can arrive in - the status line was spent on the 200 that opened the stream -
 *   and a caller that saw it as data would treat a 502 as a document.
 * - **A stream that ends saying nothing is a failure**, not an empty document.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient, ApiError } from "./http-client";
import type { StreamMessage } from "./http-client";

vi.mock("./http-client", async () => {
	const actual = await vi.importActual<typeof import("./http-client")>("./http-client");
	return {
		ApiError: actual.ApiError,
		httpClient: { post: vi.fn(), stream: vi.fn() },
	};
});

const post = vi.mocked(httpClient.post);
const stream = vi.mocked(httpClient.stream);

/** Make `httpClient.stream` hand back these messages, in order. */
function streaming(messages: StreamMessage[]) {
	stream.mockImplementation(async function* () {
		for (const message of messages) yield message;
	});
}

const event = (name: string, data: unknown): StreamMessage => ({
	kind: "event",
	event: name,
	data,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("apiService.importFetch with progress", () => {
	it("reports each progress event and resolves with the result", async () => {
		streaming([
			event("progress", { received: 1024, total: 8192 }),
			event("progress", { received: 8192, total: 8192 }),
			event("result", { content: '{"openapi":"3.0.0"}', contentType: "application/json" }),
		]);
		const seen: { received: number; total: number | null }[] = [];

		const response = await apiService.importFetch("http://x/spec.json", undefined, (p) =>
			seen.push(p)
		);

		expect(seen).toEqual([
			{ received: 1024, total: 8192 },
			{ received: 8192, total: 8192 },
		]);
		expect(response.content).toBe('{"openapi":"3.0.0"}');
	});

	it("stays on the buffered request when no progress is wanted", async () => {
		post.mockResolvedValue({ content: "{}", contentType: "application/json" });

		await apiService.importFetch("http://x/spec.json");

		expect(post).toHaveBeenCalledOnce();
		expect(stream).not.toHaveBeenCalled();
	});

	it("passes the stated bound through to the stream", async () => {
		streaming([event("result", { content: "{}", contentType: "application/json" })]);

		await apiService.importFetch("http://x/spec.json", 4096, () => {});

		expect(stream.mock.calls[0][1]).toEqual({ url: "http://x/spec.json", maxBytes: 4096 });
	});

	it("throws the engine's failure carried by an error event", async () => {
		streaming([
			event("progress", { received: 1024, total: null }),
			event("error", {
				status: 413,
				error: { code: "error", message: "Refused to fetch: over the bound" },
			}),
		]);

		// The numeric status has to survive: 413 is the one failure the dialog
		// words differently, and the error body's own `code` is "error" for it.
		const failure = await apiService
			.importFetch("http://x/spec.json", undefined, () => {})
			.catch((e: unknown) => e as ApiError);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).statusCode).toBe(413);
		expect((failure as ApiError).message).toBe("Refused to fetch: over the bound");
	});

	it("accepts a buffered body from an engine that cannot stream", async () => {
		streaming([{ kind: "buffered", data: { content: "{}", contentType: "application/json" } }]);

		// No progress is reported, because the engine reported none - but the
		// import goes through, which is the whole point of not failing here.
		const response = await apiService.importFetch("http://x/spec.json", undefined, () => {});

		expect(response.content).toBe("{}");
	});

	it("fails when the stream ends without a result", async () => {
		streaming([event("progress", { received: 1024, total: 8192 })]);

		await expect(
			apiService.importFetch("http://x/spec.json", undefined, () => {})
		).rejects.toThrow(/without/i);
	});

	it("passes the caller's cancel through to the stream", async () => {
		streaming([event("result", { content: "{}", contentType: "application/json" })]);
		const controller = new AbortController();

		await apiService.importFetch("http://x/spec.json", undefined, () => {}, controller.signal);

		expect(stream.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
	});

	it("reports an abort as an abort, not as a stream that said nothing", async () => {
		// A cancelled stream ends without a `result`, which is the same shape as a
		// stream that finished having said nothing - and the two must not read the
		// same way. "ended without returning a document" for a download the user
		// themselves cancelled would be an error report about their own click.
		stream.mockImplementation(async function* () {
			yield event("progress", { received: 1024, total: 8192 });
			const aborted = new Error("Aborted by the caller");
			aborted.name = "AbortError";
			throw aborted;
		});

		const failure = await apiService
			.importFetch("http://x/spec.json", undefined, () => {})
			.then(() => null)
			.catch((e: unknown) => e as Error);

		expect(failure?.name).toBe("AbortError");
	});
});
