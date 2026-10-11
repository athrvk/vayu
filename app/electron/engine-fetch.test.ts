/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ENGINE_CONFIG_REQUEST_TIMEOUT_MS } from "./constants";
import { engineFetch } from "./engine-fetch";

/** A fetch that never answers on its own but rejects when its signal aborts. */
function silentEngineFetch() {
	return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
		});
	});
}

/**
 * Node arms `AbortSignal.timeout` on an internal timer that fake timers do not
 * reach, so the deadline is rebuilt on the faked `setTimeout`. What this test
 * pins is that `engineFetch` hands `fetch` a signal armed for the budget.
 */
function timeoutOnFakeClock() {
	return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController();
		setTimeout(
			() => controller.abort(new DOMException("signal timed out", "TimeoutError")),
			ms
		);
		return controller.signal;
	});
}

describe("engineFetch", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("rejects with a TimeoutError once the engine has been silent for the budget", async () => {
		vi.useFakeTimers();
		const fetchImpl = silentEngineFetch();
		vi.stubGlobal("fetch", fetchImpl);
		const timeoutSpy = timeoutOnFakeClock();

		const pending = engineFetch("http://127.0.0.1:9876/config");
		const outcome = pending.then(
			() => "resolved",
			(err: Error) => err.name
		);

		await vi.advanceTimersByTimeAsync(ENGINE_CONFIG_REQUEST_TIMEOUT_MS - 1);
		let settled = false;
		void outcome.then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await expect(outcome).resolves.toBe("TimeoutError");
		expect(timeoutSpy).toHaveBeenCalledWith(ENGINE_CONFIG_REQUEST_TIMEOUT_MS);
	});

	it("forwards the url and the caller's init to fetch", async () => {
		const fetchImpl = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetchImpl);

		await engineFetch("http://127.0.0.1:9876/config", {
			method: "POST",
			body: '{"entries":{}}',
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/config",
			expect.objectContaining({ method: "POST", body: '{"entries":{}}' })
		);
	});
});
