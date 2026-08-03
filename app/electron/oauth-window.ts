/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The settle protocol for the embedded OAuth window.
 *
 * The window must answer exactly once, and until this existed it could answer
 * never. It is created hidden and shown on `ready-to-show`, so an authorize URL
 * that failed before first paint left an invisible window behind: the flow's
 * only other exit was the user closing that window, and there was no window to
 * close. The `loadURL` rejection that would have named the failure was swallowed
 * by a catch written for a different failure entirely - the deliberate abort of
 * the callback navigation, which is how a *successful* capture ends.
 *
 * `settled` is the discriminator between those two. A load failure before the
 * flow has settled is the authorize page failing and must be reported; the same
 * failure after is the (usually unresolvable) callback host, which is expected
 * and already answered. ERR_ABORTED is never a failure in either direction - it
 * is what a superseded navigation reports, including the capture's own
 * `preventDefault` and an IdP page that redirects itself mid-load.
 *
 * The deadline is the backstop for the case neither covers: a load that neither
 * completes nor fails (a host that accepts the connection and never responds).
 *
 * Kept out of oauth.ts so a fake window can drive it - oauth.ts registers
 * Electron IPC handlers at import time, which no unit test can do.
 */

export type AuthWindowResult = { callbackUrl: string } | { error: string };

export interface AuthWindowFlowParams {
	authorizeUrl: string;
	/** The registered callback URL, matched by prefix to capture the redirect. */
	redirectUri: string;
}

/** The slice of the BrowserWindow this needs, so a test can pass a fake. */
export interface AuthWindowTransport {
	/** Navigate to the authorize URL. Rejects when the load fails. */
	loadUrl: (url: string) => Promise<void>;
	/** Tear the window down. Called once, and safe on an already-gone window. */
	destroy: () => void;
	/** Arm the deadline timer. Returns a cancel function. */
	schedule: (listener: () => void, ms: number) => () => void;
}

export interface AuthWindowFlow {
	/** Settles exactly once, whichever way the flow ends. */
	readonly result: Promise<AuthWindowResult>;
	/** Arm the deadline and load the authorize URL. */
	start: () => void;
	/**
	 * Report a navigation the window is attempting. Returns `true` when it was
	 * the callback, which the caller must then cancel - the callback host is
	 * usually unresolvable and contacting it buys nothing.
	 */
	onNavigate: (url: string) => boolean;
	/** Report a main-frame load failure. */
	onLoadFailure: (errorCode: number, description: string) => void;
	/** Report that the window went away. */
	onClosed: () => void;
}

/**
 * How long the window may stay open before the flow gives up. Matches the
 * loopback branch's patience (`POLL_TIMEOUT_MS` in the renderer) - the user is
 * doing the same thing, in a different window.
 */
export const AUTH_WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Chromium's `ERR_ABORTED`: a navigation that was superseded or cancelled, not
 * one that failed. The capture path produces it on purpose.
 */
export const ERR_ABORTED = -3;

function describeLoadError(err: unknown): string {
	if (err instanceof Error && err.message) return err.message;
	if (typeof err === "string" && err) return err;
	return "unknown error";
}

/** `loadURL` rejects with a plain Error carrying Chromium's code in `errno`. */
function loadErrorCode(err: unknown): number | undefined {
	return typeof err === "object" && err !== null ? (err as { errno?: number }).errno : undefined;
}

export function createAuthWindowFlow(
	params: AuthWindowFlowParams,
	transport: AuthWindowTransport
): AuthWindowFlow {
	let settled = false;
	let cancelDeadline: (() => void) | null = null;
	let resolve!: (result: AuthWindowResult) => void;
	const result = new Promise<AuthWindowResult>((r) => {
		resolve = r;
	});

	const finish = (value: AuthWindowResult) => {
		if (settled) return;
		settled = true;
		cancelDeadline?.();
		transport.destroy();
		resolve(value);
	};

	const callbackPrefix = params.redirectUri.split("?")[0];

	// Match the registered callback URL AND require an OAuth indicator, so we
	// don't fire on intermediate IdP pages sharing the prefix (Bruno's rule).
	const matches = (url: string) =>
		url.startsWith(callbackPrefix) &&
		(url.includes("code=") || url.includes("error=") || url.includes("#"));

	return {
		result,

		start: () => {
			cancelDeadline = transport.schedule(
				() => finish({ error: "Authorization timed out" }),
				AUTH_WINDOW_TIMEOUT_MS
			);
			void transport.loadUrl(params.authorizeUrl).catch((err: unknown) => {
				if (loadErrorCode(err) === ERR_ABORTED) return;
				finish({
					error: `Could not load authorization page: ${describeLoadError(err)}`,
				});
			});
		},

		onNavigate: (url) => {
			if (!matches(url)) return false;
			finish({ callbackUrl: url });
			return true;
		},

		onLoadFailure: (errorCode, description) => {
			if (errorCode === ERR_ABORTED) return;
			finish({ error: `Could not load authorization page: ${description}` });
		},

		onClosed: () => finish({ error: "Authorization window was closed" }),
	};
}
