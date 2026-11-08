/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A buffered call's own cancel (#3352), the `request()` half of what
 * `http-client.stream.test.ts` holds for `stream()`.
 *
 * The caller's signal and the timeout end in one `AbortController`, so the
 * thing to guard is which of the two the rejection reports: a cancel told as
 * "Couldn't reach Vayu's engine in time." is a failure nobody had.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { httpClient, EngineUnreachableError } from "./http-client";

/** A fetch that never answers on its own, and rejects as a real one does on abort. */
function hangingFetch() {
	const signals: AbortSignal[] = [];
	const fetch = vi.fn((_url: string, init: RequestInit) => {
		const signal = init.signal as AbortSignal;
		signals.push(signal);
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () =>
				reject(new DOMException("The operation was aborted", "AbortError"))
			);
		});
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, signals };
}

afterEach(() => vi.unstubAllGlobals());

describe("httpClient.post with a caller signal", () => {
	it("aborts the fetch and rejects as an abort, not as a timeout", async () => {
		const { signals } = hangingFetch();
		const caller = new AbortController();

		const sent = httpClient.post("/execute", { url: "x" }, { signal: caller.signal });
		await vi.waitFor(() => expect(signals).toHaveLength(1));
		caller.abort();
		// At once, not when the timeout would have fired anyway.
		expect(signals[0].aborted).toBe(true);

		const error = await sent.catch((e: unknown) => e);
		expect(error).toMatchObject({ name: "AbortError" });
		expect(error).not.toBeInstanceOf(EngineUnreachableError);
	});

	it("puts nothing on the wire when the signal is already aborted", async () => {
		const { fetch } = hangingFetch();
		const caller = new AbortController();
		caller.abort();

		await expect(
			httpClient.post("/execute", { url: "x" }, { signal: caller.signal })
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("still calls its own timeout a timeout while a caller signal is attached", async () => {
		hangingFetch();

		await expect(
			httpClient.post(
				"/execute",
				{ url: "x" },
				{ timeout: 20, signal: new AbortController().signal }
			)
		).rejects.toThrow("Couldn't reach Vayu's engine in time.");
	});
});
