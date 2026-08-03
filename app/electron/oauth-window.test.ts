/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The embedded OAuth window must always answer.
 *
 * The hole this closes was specific: the window is created hidden and shown on
 * `ready-to-show`, so an authorize URL that failed before first paint produced
 * an invisible window, and the only exit the flow had left was the user closing
 * a window they could not see. The `loadURL` rejection naming the failure was
 * swallowed by a catch written for the *successful* path, where the callback
 * host is deliberately never reached.
 *
 * So the assertions worth holding are all about which failures settle the flow
 * and which are noise: a dead authorize host settles with an error, the
 * capture's own aborted navigation does not, and a load failure arriving after
 * a capture cannot overwrite the answer already given.
 *
 * These drive the flow through a fake window rather than Electron, which is the
 * whole reason it lives outside oauth.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	createAuthWindowFlow,
	AUTH_WINDOW_TIMEOUT_MS,
	ERR_ABORTED,
	type AuthWindowFlow,
	type AuthWindowResult,
	type AuthWindowTransport,
} from "./oauth-window";

// oauth.ts registers IPC handlers at import time, so the wiring itself can only
// be read. Everything above this line would still pass with `did-fail-load`
// never subscribed, which is half of the bug being fixed.
const oauthSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "oauth.ts"), "utf8");

const PARAMS = {
	authorizeUrl: "https://idp.example.com/authorize?client_id=abc",
	redirectUri: "https://app.example.com/callback",
};

const CALLBACK = "https://app.example.com/callback?code=xyz&state=s";

/** A BrowserWindow that never existed, plus the timer the adapter would arm. */
function fakeWindow() {
	let rejectLoad!: (err: unknown) => void;
	const load = new Promise<void>((_resolve, reject) => {
		rejectLoad = reject;
	});
	let timer: { fire: () => void; ms: number } | null = null;
	let deadlineCancelled = false;

	const transport: AuthWindowTransport = {
		loadUrl: vi.fn(() => load),
		destroy: vi.fn(),
		schedule: (listener, ms) => {
			timer = { fire: listener, ms };
			return () => {
				deadlineCancelled = true;
			};
		},
	};

	return {
		transport,
		destroy: transport.destroy as ReturnType<typeof vi.fn>,
		/** The authorize page failed to load. */
		failLoad: async (err: unknown) => {
			rejectLoad(err);
			await load.catch(() => undefined);
		},
		/** The deadline expired. */
		expire: () => timer?.fire(),
		timeoutMs: () => timer?.ms,
		deadlineCancelled: () => deadlineCancelled,
	};
}

/** Chromium hands the code back on the rejection, not in the message. */
function loadError(code: number, message: string): Error {
	return Object.assign(new Error(message), { errno: code });
}

/**
 * The flow's answer, or `"pending"` when it has not settled. Racing an
 * already-resolved marker is what turns "never settles" - the defect - into a
 * failing assertion instead of a hanging test.
 */
async function answer(flow: AuthWindowFlow): Promise<AuthWindowResult | "pending"> {
	await Promise.resolve();
	await Promise.resolve();
	return Promise.race([flow.result, Promise.resolve<"pending">("pending")]);
}

describe("a failed authorize load settles the flow", () => {
	it("reports the load failure instead of hanging on a window nobody can see", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		await w.failLoad(loadError(-105, "ERR_NAME_NOT_RESOLVED (-105) loading 'https://…'"));

		expect(await answer(flow)).toEqual({
			error: "Could not load authorization page: ERR_NAME_NOT_RESOLVED (-105) loading 'https://…'",
		});
		expect(w.destroy).toHaveBeenCalledTimes(1); // no hidden window survives
	});

	it("reports a main-frame did-fail-load with no rejection to go with it", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		flow.onLoadFailure(-102, "ERR_CONNECTION_REFUSED");

		expect(await answer(flow)).toEqual({
			error: "Could not load authorization page: ERR_CONNECTION_REFUSED",
		});
		expect(w.destroy).toHaveBeenCalledTimes(1);
	});

	it("survives a rejection that is not an Error at all", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		await w.failLoad(undefined);

		expect(await answer(flow)).toEqual({
			error: "Could not load authorization page: unknown error",
		});
	});
});

describe("ERR_ABORTED is a superseded navigation, never a failure", () => {
	it("ignores an aborted load - an IdP that redirects itself mid-load is fine", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		await w.failLoad(loadError(ERR_ABORTED, "ERR_ABORTED (-3) loading 'https://…'"));

		expect(await answer(flow)).toBe("pending");
		expect(w.destroy).not.toHaveBeenCalled();
	});

	it("ignores an aborted did-fail-load, which the capture itself produces", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		flow.onLoadFailure(ERR_ABORTED, "ERR_ABORTED");

		expect(await answer(flow)).toBe("pending");
	});
});

describe("the capture path is unaffected", () => {
	it("settles with the callback URL and tells the caller to cancel the navigation", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		expect(flow.onNavigate(CALLBACK)).toBe(true);

		expect(await answer(flow)).toEqual({ callbackUrl: CALLBACK });
		expect(w.deadlineCancelled()).toBe(true);
	});

	it("does not fire on an intermediate IdP page sharing the callback prefix", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		expect(flow.onNavigate("https://app.example.com/callback/consent")).toBe(false);
		expect(await answer(flow)).toBe("pending");
	});

	it("keeps the captured URL when the callback host then fails to load", async () => {
		// This is the failure the old catch existed for: the fake callback host
		// is unresolvable on purpose, and its rejection must not become an error.
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		flow.onNavigate(CALLBACK);
		await w.failLoad(loadError(-105, "ERR_NAME_NOT_RESOLVED"));
		flow.onLoadFailure(-105, "ERR_NAME_NOT_RESOLVED");

		expect(await answer(flow)).toEqual({ callbackUrl: CALLBACK });
		expect(w.destroy).toHaveBeenCalledTimes(1);
	});
});

describe("the deadline is the backstop for a load that neither ends nor fails", () => {
	it("gives up after the ceiling and takes the window with it", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		expect(w.timeoutMs()).toBe(AUTH_WINDOW_TIMEOUT_MS);
		expect(await answer(flow)).toBe("pending");

		w.expire();

		expect(await answer(flow)).toEqual({ error: "Authorization timed out" });
		expect(w.destroy).toHaveBeenCalledTimes(1);
	});

	it("cannot overwrite an answer already given", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		flow.onNavigate(CALLBACK);
		w.expire();

		expect(await answer(flow)).toEqual({ callbackUrl: CALLBACK });
		expect(w.destroy).toHaveBeenCalledTimes(1);
	});
});

describe("the window going away settles the flow", () => {
	it("reports the close, once, however many times it is reported", async () => {
		const w = fakeWindow();
		const flow = createAuthWindowFlow(PARAMS, w.transport);
		flow.start();

		flow.onClosed();
		flow.onClosed();

		expect(await answer(flow)).toEqual({ error: "Authorization window was closed" });
		expect(w.destroy).toHaveBeenCalledTimes(1);
	});
});

describe("oauth.ts wiring", () => {
	it("read the real oauth.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(oauthSource.length).toBeGreaterThan(1000);
		expect(oauthSource).toContain("createAuthWindowFlow");
	});

	it("subscribes did-fail-load, gated to the main frame", () => {
		expect(oauthSource).toContain('win.webContents.on("did-fail-load"');
		const handler = oauthSource.slice(oauthSource.indexOf('"did-fail-load"'));
		expect(handler).toContain(
			"if (isMainFrame) flow.onLoadFailure(errorCode, errorDescription)"
		);
	});

	it("keeps no second copy of the settle bookkeeping", () => {
		// The `settled` flag lived here and was the discriminator the catch
		// failed to use; a copy left behind would drift from the flow's own.
		expect(oauthSource).not.toContain("let settled");
	});

	it("starts the flow and returns its promise, rather than resolving its own", () => {
		expect(oauthSource).toContain("flow.start()");
		expect(oauthSource).toContain("return flow.result");
	});
});
