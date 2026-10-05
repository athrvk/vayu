/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's CORS, done by the shell rather than by the engine.
 *
 * The invariant: **the engine serves no browser and emits no CORS header.** It
 * refuses every non-`OPTIONS` request that carries an `Origin` (any value,
 * `null` included) and every request whose `Host` is not its own loopback
 * address, so a page in the user's browser can neither read it nor drive it.
 *
 * The renderer is a browser context as well, so this bridge is the only reason
 * it can talk to the engine at all. On the session the main window uses, every
 * request to `ENGINE_ORIGIN` loses its `Origin` and `Referer` (both name the
 * renderer's location) and every response from it gains the headers the
 * renderer's own CORS check asks for. In development the renderer is the Vite
 * server and needs all of it. Packaged it is a `file:` load, which Electron 44
 * exempts from CORS altogether (no `Origin`, no preflight, no response check -
 * measured, not documented); the bridge is what keeps that build working the
 * day Chromium stops exempting it, so it is installed for both.
 *
 * **The URL filter is the whole boundary.** Nothing outside `ENGINE_ORIGIN` is
 * touched, and the bridge grants nothing beyond that origin. It is safe only
 * because nothing but the app's own document runs in this session: the OAuth
 * windows load third-party pages in `oauth:` partitions of their own, and
 * `window-navigation.ts` keeps the main window on the app. Loading untrusted
 * content into this session would hand it the engine.
 *
 * Electron keeps one listener per `webRequest` event per session, and a second
 * registration silently replaces the first. A future concern that needs these
 * events therefore joins this module (widen the filter, add its own branch to
 * the handlers) instead of registering beside it; `engine-origin.test.ts` fails
 * on a `webRequest` registration anywhere else under `electron/`.
 *
 * Kept free of Electron at runtime so the handlers are unit-tested over plain
 * `details` objects; `installEngineOriginBridge` is the one place they meet a
 * real session.
 */

import type { Session } from "electron";
import { ENGINE_HOST, ENGINE_PORT } from "./constants.js";

/** The engine's management API, exactly as the renderer addresses it (`src/config/network.ts`). */
export const ENGINE_ORIGIN = `http://${ENGINE_HOST}:${ENGINE_PORT}`;

/**
 * What Chromium matches before any handler runs. One host, one port, one
 * scheme: `localhost:9876` and `[::1]:9876` reach the same engine but are not
 * the renderer's address for it, so a request to either keeps its `Origin` and
 * the engine refuses it.
 */
export const ENGINE_REQUEST_FILTER = { urls: [`${ENGINE_ORIGIN}/*`] };

/** Request headers that say where the renderer is. The engine refuses the first. */
const RENDERER_LOCATION_HEADERS = ["origin", "referer"];

const ALLOW_ORIGIN = "Access-Control-Allow-Origin";
const ALLOW_METHODS = "Access-Control-Allow-Methods";
const ALLOW_HEADERS = "Access-Control-Allow-Headers";

/** Whether `url` is a request to the engine - the handlers' own copy of the filter. */
export function isEngineUrl(url: string): boolean {
	try {
		return new URL(url).origin === ENGINE_ORIGIN;
	} catch {
		return false;
	}
}

/** `headers` without any of `names`, compared case-insensitively. */
function withoutHeaders<T>(
	headers: Record<string, T>,
	names: readonly string[]
): Record<string, T> {
	const drop = new Set(names.map((name) => name.toLowerCase()));
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase()))
	);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** What a CORS preflight asks permission for. */
export interface PreflightAsk {
	method: string;
	headers?: string;
}

/** The subset of a `webRequest` request's details the bridge reads. */
export interface EngineRequestDetails {
	id: number;
	url: string;
	method: string;
	requestHeaders: Record<string, string>;
}

/** The subset of a `webRequest` response's details the bridge reads. */
export interface EngineResponseDetails {
	id: number;
	url: string;
	responseHeaders?: Record<string, string[]>;
}

/**
 * The preflight's question, or null for any other request. A preflight is an
 * `OPTIONS` carrying `Access-Control-Request-Method`; a bare `OPTIONS` is an
 * ordinary request.
 */
export function preflightAsk(details: EngineRequestDetails): PreflightAsk | null {
	if (details.method !== "OPTIONS") return null;
	const method = headerValue(details.requestHeaders, "Access-Control-Request-Method");
	if (!method) return null;
	const headers = headerValue(details.requestHeaders, "Access-Control-Request-Headers");
	return headers ? { method, headers } : { method };
}

/** The request as the engine should see it: no `Origin`, no `Referer`, nothing else changed. */
export function withoutRendererLocation(
	requestHeaders: Record<string, string>
): Record<string, string> {
	return withoutHeaders(requestHeaders, RENDERER_LOCATION_HEADERS);
}

/**
 * The response with the CORS headers the renderer's check needs. Every request
 * gets `Access-Control-Allow-Origin: *`; a preflight's answer also echoes the
 * method and headers it asked for. Any copy the engine already sent is replaced,
 * not appended to: a doubled `*, *` fails the check.
 *
 * The wildcard is enough because the renderer never sends credentials to the
 * engine; a credentialed request would need the origin echoed instead.
 */
export function withEngineCors(
	responseHeaders: Record<string, string[]> | undefined,
	ask: PreflightAsk | null
): Record<string, string[]> {
	const headers = withoutHeaders(responseHeaders ?? {}, [
		ALLOW_ORIGIN,
		ALLOW_METHODS,
		ALLOW_HEADERS,
	]);
	headers[ALLOW_ORIGIN] = ["*"];
	if (ask) {
		headers[ALLOW_METHODS] = [ask.method];
		if (ask.headers) headers[ALLOW_HEADERS] = [ask.headers];
	}
	return headers;
}

/**
 * The bridge's handlers, holding the one piece of state they share: a response's
 * details do not carry the request's headers, so what a preflight asked for is
 * kept by request id from the moment it is sent until its response or its
 * failure arrives.
 */
export function createEngineOriginBridge() {
	const asks = new Map<number, PreflightAsk>();

	return {
		beforeSendHeaders(details: EngineRequestDetails): {
			requestHeaders?: Record<string, string>;
		} {
			if (!isEngineUrl(details.url)) return {};
			const ask = preflightAsk(details);
			if (ask) asks.set(details.id, ask);
			return { requestHeaders: withoutRendererLocation(details.requestHeaders) };
		},

		headersReceived(details: EngineResponseDetails): {
			responseHeaders?: Record<string, string[]>;
		} {
			if (!isEngineUrl(details.url)) return {};
			const ask = asks.get(details.id) ?? null;
			asks.delete(details.id);
			return { responseHeaders: withEngineCors(details.responseHeaders, ask) };
		},

		/** A preflight the engine never answered (it was down, or the load was cancelled). */
		errorOccurred(details: { id: number }): void {
			asks.delete(details.id);
		},

		/** Preflights sent and not yet answered or failed. */
		pendingPreflights(): number {
			return asks.size;
		},
	};
}

/**
 * Wire the bridge into `session`. Called once, before the main window loads,
 * so the renderer's first request already goes through it.
 */
export function installEngineOriginBridge(session: Pick<Session, "webRequest">): void {
	const bridge = createEngineOriginBridge();
	session.webRequest.onBeforeSendHeaders(ENGINE_REQUEST_FILTER, (details, callback) =>
		callback(bridge.beforeSendHeaders(details))
	);
	session.webRequest.onHeadersReceived(ENGINE_REQUEST_FILTER, (details, callback) =>
		callback(bridge.headersReceived(details))
	);
	session.webRequest.onErrorOccurred(ENGINE_REQUEST_FILTER, (details) =>
		bridge.errorOccurred(details)
	);
}
