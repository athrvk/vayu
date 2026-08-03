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
 * The interactive flow must not be able to wait forever.
 *
 * The loopback branch has always had a deadline; the embedded branch awaited
 * `oauthOpenWindow` with none at all, so a main process that never answered -
 * an authorize URL that failed before the hidden window ever painted - spun the
 * UI with no error and no way back short of a restart. The main process now
 * owns the real deadline and closes that window itself; this ceiling is the
 * backstop for the answer never arriving, and is deliberately the longer of the
 * two so the specific error wins whenever there is one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInteractiveAuthorization, InteractiveAuthError } from "./authorize";
import type { OAuth2Config } from "@/types";

const startOAuth2Authorize = vi.fn();
const completeOAuth2Authorize = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		startOAuth2Authorize: (...a: unknown[]) => startOAuth2Authorize(...a),
		completeOAuth2Authorize: (...a: unknown[]) => completeOAuth2Authorize(...a),
	},
}));

const CONFIG: OAuth2Config = {
	grantType: "authorization_code",
	accessTokenUrl: "https://idp.example.com/token",
	clientId: "abc",
	useEmbeddedBrowser: true,
};

const STARTED = {
	attemptId: "attempt_1",
	authorizeUrl: "https://idp.example.com/authorize?client_id=abc",
	redirectUri: "https://app.example.com/callback",
};

/** Install a desktop bridge whose embedded window answers however we say. */
function bridge(oauthOpenWindow: () => Promise<unknown>) {
	vi.stubGlobal("electronAPI", { oauthOpenWindow, openExternalUrl: vi.fn() });
}

beforeEach(() => {
	vi.useFakeTimers();
	startOAuth2Authorize.mockResolvedValue(STARTED);
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
		const settled = expect(flow).rejects.toThrow("Authorization timed out");

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

		await settled;
	});

	it("waits longer than the window's own deadline, so its error wins the race", async () => {
		// The main process settles at 5 minutes with a specific message; if this
		// ceiling were not the later of the two, that message would be lost.
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
