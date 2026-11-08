/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The interactive flow must not be able to wait forever, and must wait on the
 * engine's deadline rather than a clock of its own.
 *
 * The engine reports `expiresAt` when it starts an attempt and enforces it. The
 * loopback branch polls until just past it; the embedded branch hands the
 * window the time remaining and awaits the window with the same margin. The
 * main process owns that window and closes it itself; the ceiling here is the
 * backstop for the answer never arriving, and is deliberately the later of the
 * two so the specific error wins whenever there is one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInteractiveAuthorization, InteractiveAuthError, EXPIRY_GRACE_MS } from "./authorize";
import type { OAuth2Config } from "@/types";

const startOAuth2Authorize = vi.fn();
const completeOAuth2Authorize = vi.fn();
const getOAuth2AuthorizeStatus = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		startOAuth2Authorize: (...a: unknown[]) => startOAuth2Authorize(...a),
		completeOAuth2Authorize: (...a: unknown[]) => completeOAuth2Authorize(...a),
		getOAuth2AuthorizeStatus: (...a: unknown[]) => getOAuth2AuthorizeStatus(...a),
	},
}));

const CONFIG: OAuth2Config = {
	grantType: "authorization_code",
	accessTokenUrl: "https://idp.example.com/token",
	clientId: "abc",
	useEmbeddedBrowser: true,
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** What the engine answers to a start, expiring `ttlMs` after the (fake) now. */
function started(ttlMs: number = FIVE_MINUTES_MS) {
	return {
		attemptId: "attempt_1",
		authorizeUrl: "https://idp.example.com/authorize?client_id=abc",
		redirectUri: "https://app.example.com/callback",
		expiresAt: Date.now() + ttlMs,
	};
}

/** Install a desktop bridge whose embedded window answers however we say. */
function bridge(oauthOpenWindow: (...a: unknown[]) => Promise<unknown>) {
	vi.stubGlobal("electronAPI", { oauthOpenWindow, openExternalUrl: vi.fn() });
}

/** Observe whether `flow` has settled, without leaving its rejection unhandled. */
function watch(flow: Promise<unknown>) {
	const state = { settled: false };
	void flow.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		}
	);
	return state;
}

beforeEach(() => {
	vi.useFakeTimers();
	startOAuth2Authorize.mockImplementation(() => Promise.resolve(started()));
	completeOAuth2Authorize.mockResolvedValue({ state: "completed", cacheKey: "key" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("the embedded branch cannot await forever", () => {
	it("gives up once the ceiling passes, rather than spinning with no error", async () => {
		bridge(() => new Promise(() => undefined)); // the main process never answers

		const flow = runInteractiveAuthorization(CONFIG);
		const settled = expect(flow).rejects.toThrow(InteractiveAuthError);

		// Let the start call resolve so the await on the window is actually armed.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

		await settled;
	});

	it("names the timeout, so the UI has something to show", async () => {
		bridge(() => new Promise(() => undefined));

		const flow = runInteractiveAuthorization(CONFIG);
		const settled = expect(flow).rejects.toThrow("Couldn't finish authorization in time.");

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

		await settled;
	});

	it("waits longer than the window's own deadline, so its error wins the race", async () => {
		// The main process settles at the attempt's expiry with a specific message;
		// if this ceiling were not the later of the two, that message would be lost.
		bridge(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ error: "Could not load authorization page: nope" }),
						5 * 60 * 1000
					)
				)
		);

		const flow = runInteractiveAuthorization(CONFIG);
		const settled = expect(flow).rejects.toThrow("Could not load authorization page: nope");

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

		await settled;
	});
});

describe("a window that answers is untouched by the ceiling", () => {
	it("completes the flow on a captured callback URL", async () => {
		bridge(() => Promise.resolve({ callbackUrl: "https://app.example.com/callback?code=xyz" }));

		const flow = runInteractiveAuthorization(CONFIG);
		await vi.advanceTimersByTimeAsync(0);

		await expect(flow).resolves.toBe("key");
		expect(completeOAuth2Authorize).toHaveBeenCalledWith(
			"attempt_1",
			"https://app.example.com/callback?code=xyz"
		);
	});

	it("surfaces the window's own error without waiting out the ceiling", async () => {
		bridge(() => Promise.resolve({ error: "Authorization window was closed" }));

		const flow = runInteractiveAuthorization(CONFIG);
		const settled = expect(flow).rejects.toThrow("Authorization window was closed");

		await vi.advanceTimersByTimeAsync(0);

		await settled;
		expect(completeOAuth2Authorize).not.toHaveBeenCalled();
	});
});

describe("the embedded window is given the engine's remaining time", () => {
	it.each([[30 * 1000], [FIVE_MINUTES_MS], [20 * 60 * 1000]])(
		"passes the %d ms left on the attempt, not a fixed five minutes",
		async (ttlMs) => {
			startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));
			const open = vi.fn(() =>
				Promise.resolve({ callbackUrl: "https://app.example.com/callback?code=x" })
			);
			bridge(open);

			const flow = runInteractiveAuthorization(CONFIG);
			await vi.advanceTimersByTimeAsync(0);
			await flow;

			expect(open).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: ttlMs }));
		}
	);

	it("ceases to wait at the engine's expiry plus the grace, not at five minutes", async () => {
		const ttlMs = 30 * 1000;
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));
		bridge(() => new Promise(() => undefined));

		const flow = runInteractiveAuthorization(CONFIG);
		const settled = expect(flow).rejects.toThrow("Couldn't finish authorization in time.");
		const state = watch(flow);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(ttlMs + EXPIRY_GRACE_MS - 1);
		expect(state.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await settled;
	});

	it("keeps waiting past five minutes when the engine's attempt lives longer", async () => {
		const ttlMs = 20 * 60 * 1000;
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));
		bridge(() => new Promise(() => undefined));

		const flow = runInteractiveAuthorization(CONFIG);
		const state = watch(flow);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS + EXPIRY_GRACE_MS + 1000);
		expect(state.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(ttlMs);
		await expect(flow).rejects.toThrow(InteractiveAuthError);
	});

	it("refuses to open a window for an attempt that has already expired", async () => {
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(-1)));
		const open = vi.fn(() => Promise.resolve({ error: "unreachable" }));
		bridge(open);

		await expect(runInteractiveAuthorization(CONFIG)).rejects.toThrow(
			"Couldn't finish authorization in time."
		);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("the loopback branch polls until the engine's expiry", () => {
	const LOOPBACK = { ...CONFIG, useEmbeddedBrowser: false };

	beforeEach(() => {
		bridge(() => Promise.reject(new Error("the loopback branch opens no window")));
		getOAuth2AuthorizeStatus.mockResolvedValue({ state: "pending" });
	});

	it("stops at the engine's expiry plus the grace, not at five minutes", async () => {
		const ttlMs = 20 * 1000;
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));

		const flow = runInteractiveAuthorization(LOOPBACK);
		const settled = expect(flow).rejects.toThrow("Couldn't finish authorization in time.");
		const state = watch(flow);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(ttlMs + EXPIRY_GRACE_MS - 1);
		expect(state.settled).toBe(false);

		// One poll interval later the loop has seen the deadline pass.
		await vi.advanceTimersByTimeAsync(2000);
		await settled;

		const polls = getOAuth2AuthorizeStatus.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(getOAuth2AuthorizeStatus).toHaveBeenCalledTimes(polls);
	});

	it("keeps polling past five minutes when the engine's attempt lives longer", async () => {
		const ttlMs = 20 * 60 * 1000;
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));

		const flow = runInteractiveAuthorization(LOOPBACK);
		const state = watch(flow);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS + EXPIRY_GRACE_MS + 2000);
		expect(state.settled).toBe(false);

		await vi.advanceTimersByTimeAsync(ttlMs);
		await expect(flow).rejects.toThrow("Couldn't finish authorization in time.");
	});

	it("surfaces the engine's own timeout answer ahead of the local ceiling", async () => {
		const ttlMs = 20 * 1000;
		startOAuth2Authorize.mockImplementation(() => Promise.resolve(started(ttlMs)));
		const expiresAt = started(ttlMs).expiresAt;
		getOAuth2AuthorizeStatus.mockImplementation(() =>
			Promise.resolve(
				Date.now() >= expiresAt
					? { state: "failed", error: "Authorization timed out" }
					: { state: "pending" }
			)
		);

		const flow = runInteractiveAuthorization(LOOPBACK);
		const settled = expect(flow).rejects.toThrow("Authorization timed out");
		await vi.advanceTimersByTimeAsync(ttlMs + 2000);

		await settled;
	});

	it("returns the cache key the engine reports once the sign-in completes", async () => {
		getOAuth2AuthorizeStatus
			.mockResolvedValueOnce({ state: "pending" })
			.mockResolvedValueOnce({ state: "completed", cacheKey: "loopback-key" });

		const flow = runInteractiveAuthorization(LOOPBACK);
		await vi.advanceTimersByTimeAsync(3000);

		await expect(flow).resolves.toBe("loopback-key");
	});
});

describe("an engine that reports no usable expiry", () => {
	it.each([
		["embedded", CONFIG],
		["loopback", { ...CONFIG, useEmbeddedBrowser: false }],
	])(
		"fails the %s branch loudly instead of waiting on a NaN deadline",
		async (_branch, config) => {
			const { expiresAt: _omitted, ...withoutExpiry } = started();
			startOAuth2Authorize.mockResolvedValue(withoutExpiry);
			const open = vi.fn(() => Promise.resolve({ error: "unreachable" }));
			bridge(open);

			await expect(runInteractiveAuthorization(config)).rejects.toThrow(
				"Couldn't start authorization - Vayu's engine sent no expiry."
			);
			expect(open).not.toHaveBeenCalled();
			expect(getOAuth2AuthorizeStatus).not.toHaveBeenCalled();
		}
	);
});
