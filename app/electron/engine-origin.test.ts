/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine refuses every request that carries an `Origin`, so this bridge is
 * what stands between the renderer and a dead app, and its URL filter is what
 * stands between every other origin and the engine. Both directions are held:
 * the engine's requests are rewritten, and nothing else is.
 *
 * Chromium's side of it (that a preflight passes through `onBeforeSendHeaders`
 * and that a header added in `onHeadersReceived` satisfies the preflight
 * check) was measured once in a real Electron window against a stub engine;
 * these drive the handlers over plain `details` objects, which is all of the
 * bridge that is ours.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";
import { ENGINE_BASE_URL } from "@/config/network";
import {
	ENGINE_ORIGIN,
	ENGINE_REQUEST_FILTER,
	createEngineOriginBridge,
	installEngineOriginBridge,
	isEngineUrl,
	type EngineRequestDetails,
} from "./engine-origin.js";

const electronDir = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(electronDir, "main.ts"), "utf8");

const ENGINE = "http://127.0.0.1:9876";

/** A Chromium URL pattern read as a whole-URL glob: `*` is any run of characters. */
function patternMatches(pattern: string, url: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(url);
}

function request(overrides: Partial<EngineRequestDetails> = {}): EngineRequestDetails {
	return {
		id: 1,
		url: `${ENGINE}/health`,
		method: "GET",
		requestHeaders: {},
		...overrides,
	};
}

describe("the filter is the engine and nothing else", () => {
	const engineUrls = [
		`${ENGINE}/`,
		`${ENGINE}/health`,
		`${ENGINE}/runs/42/samples?limit=100`,
		`${ENGINE}/inbox/7/live?lastEventId=3`,
	];
	const otherUrls = [
		"http://localhost:9876/health",
		"http://[::1]:9876/health",
		"http://127.0.0.1:9877/health",
		"http://127.0.0.1:98760/health",
		"http://127.0.0.1/health",
		"https://127.0.0.1:9876/health",
		"ws://127.0.0.1:9876/health",
		"http://127.0.0.1:9876.evil.example/health",
		"http://127.0.0.1:9876@evil.example/health",
		`https://evil.example/?next=${ENGINE}/health`,
		"http://localhost:5173/src/main.tsx",
		"file:///opt/Vayu/resources/app.asar/dist/index.html",
	];

	it("is one pattern, the renderer's own engine address", () => {
		// A renderer call to any other spelling of the engine keeps its Origin and
		// is refused, so the two constants must be the same string.
		expect(ENGINE_ORIGIN).toBe(ENGINE_BASE_URL);
		expect(ENGINE_REQUEST_FILTER).toEqual({ urls: [`${ENGINE}/*`] });
	});

	it.each(engineUrls)("matches %s", (url) => {
		expect(ENGINE_REQUEST_FILTER.urls.some((p) => patternMatches(p, url))).toBe(true);
		expect(isEngineUrl(url)).toBe(true);
	});

	it.each(otherUrls)("does not match %s", (url) => {
		expect(ENGINE_REQUEST_FILTER.urls.some((p) => patternMatches(p, url))).toBe(false);
		expect(isEngineUrl(url)).toBe(false);
	});

	it("refuses what does not parse", () => {
		expect(isEngineUrl("not a url")).toBe(false);
		expect(isEngineUrl("")).toBe(false);
	});
});

describe("a request to the engine", () => {
	it("loses Origin and Referer, whatever their case, and keeps everything else", () => {
		const bridge = createEngineOriginBridge();
		const answer = bridge.beforeSendHeaders(
			request({
				method: "POST",
				url: `${ENGINE}/request`,
				requestHeaders: {
					Origin: "http://localhost:5173",
					referer: "http://localhost:5173/",
					"Content-Type": "application/json",
					Accept: "*/*",
					"ngrok-skip-browser-warning": "true",
				},
			})
		);

		expect(answer.requestHeaders).toEqual({
			"Content-Type": "application/json",
			Accept: "*/*",
			"ngrok-skip-browser-warning": "true",
		});
	});

	it("loses an opaque Origin too, which the engine refuses like any other", () => {
		const bridge = createEngineOriginBridge();
		const answer = bridge.beforeSendHeaders(request({ requestHeaders: { origin: "null" } }));
		expect(answer.requestHeaders).toEqual({});
	});

	it("gains only Access-Control-Allow-Origin on its response", () => {
		const bridge = createEngineOriginBridge();
		bridge.beforeSendHeaders(request({ id: 5 }));
		const answer = bridge.headersReceived({
			id: 5,
			url: `${ENGINE}/health`,
			responseHeaders: {
				"Content-Type": ["application/json"],
				"Cache-Control": ["no-store"],
			},
		});

		expect(answer.responseHeaders).toEqual({
			"Content-Type": ["application/json"],
			"Cache-Control": ["no-store"],
			"Access-Control-Allow-Origin": ["*"],
		});
	});

	it("replaces an Allow-Origin the engine already sent rather than doubling it", () => {
		// An engine from before the header was dropped still sends `*`; two values
		// read as `*, *` and fail the renderer's check.
		const bridge = createEngineOriginBridge();
		const answer = bridge.headersReceived({
			id: 6,
			url: `${ENGINE}/health`,
			responseHeaders: { "access-control-allow-origin": ["*"] },
		});

		expect(answer.responseHeaders).toEqual({ "Access-Control-Allow-Origin": ["*"] });
	});

	it("answers a response that arrived with no headers at all", () => {
		const bridge = createEngineOriginBridge();
		expect(bridge.headersReceived({ id: 7, url: `${ENGINE}/health` }).responseHeaders).toEqual({
			"Access-Control-Allow-Origin": ["*"],
		});
	});
});

describe("a preflight to the engine", () => {
	const preflight = (headers: Record<string, string>) =>
		request({
			id: 11,
			method: "OPTIONS",
			url: `${ENGINE}/collections`,
			requestHeaders: { Origin: "http://localhost:5173", ...headers },
		});

	it("is answered with the method and headers it asked for", () => {
		const bridge = createEngineOriginBridge();
		const sent = bridge.beforeSendHeaders(
			preflight({
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type,ngrok-skip-browser-warning",
			})
		);
		expect(sent.requestHeaders).toEqual({
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "content-type,ngrok-skip-browser-warning",
		});

		const answer = bridge.headersReceived({
			id: 11,
			url: `${ENGINE}/collections`,
			responseHeaders: {},
		});
		expect(answer.responseHeaders).toEqual({
			"Access-Control-Allow-Origin": ["*"],
			"Access-Control-Allow-Methods": ["POST"],
			"Access-Control-Allow-Headers": ["content-type,ngrok-skip-browser-warning"],
		});
		expect(bridge.pendingPreflights()).toBe(0);
	});

	it("names no headers when it asked for none", () => {
		const bridge = createEngineOriginBridge();
		bridge.beforeSendHeaders(preflight({ "access-control-request-method": "DELETE" }));
		const answer = bridge.headersReceived({ id: 11, url: `${ENGINE}/collections` });
		expect(answer.responseHeaders).toEqual({
			"Access-Control-Allow-Origin": ["*"],
			"Access-Control-Allow-Methods": ["DELETE"],
		});
	});

	it("is only an OPTIONS that asks: a bare OPTIONS is an ordinary request", () => {
		const bridge = createEngineOriginBridge();
		bridge.beforeSendHeaders(preflight({}));
		expect(bridge.pendingPreflights()).toBe(0);
		expect(
			bridge.headersReceived({ id: 11, url: `${ENGINE}/collections` }).responseHeaders
		).toEqual({ "Access-Control-Allow-Origin": ["*"] });
	});

	it("belongs to the preflight alone, not the request that follows it", () => {
		// The ask belongs to the preflight's own id; the actual request that
		// follows has another and gets the plain answer.
		const bridge = createEngineOriginBridge();
		bridge.beforeSendHeaders(preflight({ "Access-Control-Request-Method": "PUT" }));
		const actual = bridge.headersReceived({ id: 12, url: `${ENGINE}/collections` });
		expect(actual.responseHeaders).toEqual({ "Access-Control-Allow-Origin": ["*"] });
	});

	it("is forgotten when it fails, so an engine that is down leaks nothing", () => {
		const bridge = createEngineOriginBridge();
		bridge.beforeSendHeaders(preflight({ "Access-Control-Request-Method": "POST" }));
		expect(bridge.pendingPreflights()).toBe(1);
		bridge.errorOccurred({ id: 11 });
		expect(bridge.pendingPreflights()).toBe(0);
	});
});

describe("a request anywhere else", () => {
	it("is left exactly as Chromium sent and received it", () => {
		const bridge = createEngineOriginBridge();
		const url = "http://localhost:9876/health";
		expect(
			bridge.beforeSendHeaders(
				request({
					url,
					method: "OPTIONS",
					requestHeaders: {
						Origin: "https://evil.example",
						"Access-Control-Request-Method": "POST",
					},
				})
			)
		).toEqual({});
		expect(bridge.pendingPreflights()).toBe(0);
		expect(bridge.headersReceived({ id: 1, url, responseHeaders: {} })).toEqual({});
	});
});

describe("installEngineOriginBridge", () => {
	function fakeSession() {
		const listeners = {
			beforeSendHeaders: vi.fn(),
			headersReceived: vi.fn(),
			errorOccurred: vi.fn(),
		};
		const webRequest = {
			onBeforeSendHeaders: listeners.beforeSendHeaders,
			onHeadersReceived: listeners.headersReceived,
			onErrorOccurred: listeners.errorOccurred,
		};
		return { listeners, session: { webRequest } as unknown as Session };
	}

	it("registers each listener on the engine filter and answers through the bridge", () => {
		const { listeners, session } = fakeSession();
		installEngineOriginBridge(session);

		for (const register of Object.values(listeners)) {
			expect(register).toHaveBeenCalledTimes(1);
			expect(register.mock.calls[0][0]).toBe(ENGINE_REQUEST_FILTER);
		}

		const sendCallback = vi.fn();
		listeners.beforeSendHeaders.mock.calls[0][1](
			{
				id: 3,
				url: `${ENGINE}/echo`,
				method: "OPTIONS",
				requestHeaders: { Origin: "null", "Access-Control-Request-Method": "POST" },
			},
			sendCallback
		);
		expect(sendCallback).toHaveBeenCalledWith({
			requestHeaders: { "Access-Control-Request-Method": "POST" },
		});

		const receiveCallback = vi.fn();
		listeners.headersReceived.mock.calls[0][1](
			{ id: 3, url: `${ENGINE}/echo`, responseHeaders: {} },
			receiveCallback
		);
		expect(receiveCallback).toHaveBeenCalledWith({
			responseHeaders: {
				"Access-Control-Allow-Origin": ["*"],
				"Access-Control-Allow-Methods": ["POST"],
			},
		});
	});
});

/*
 * main.ts creates windows and starts the engine at import time, so its wiring
 * can only be read - the same approach `startup-order.test.ts` takes.
 */
describe("main.ts", () => {
	it("installs the bridge on the default session before it creates the window", () => {
		// Mutation check: move the install below `createWindow();` and the first
		// requests of a dev renderer go out unbridged and are refused.
		const installAt = mainSource.indexOf(
			"\n\tinstallEngineOriginBridge(session.defaultSession);"
		);
		const windowAt = mainSource.indexOf("\n\tcreateWindow();");
		expect(installAt).toBeGreaterThan(-1);
		expect(windowAt).toBeGreaterThan(-1);
		expect(installAt).toBeLessThan(windowAt);
	});

	it("gives the main window the default session, which is where the bridge is", () => {
		const start = mainSource.indexOf("mainWindow = new BrowserWindow({");
		const end = mainSource.indexOf("webPreferences: {", start);
		const close = mainSource.indexOf("},", end);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const webPreferences = mainSource.slice(end, close);
		expect(webPreferences).toContain("contextIsolation: true");
		expect(webPreferences).not.toMatch(/\bpartition\b|\bsession\b/);
	});
});

/*
 * Electron keeps one listener per webRequest event per session, and a second
 * registration replaces the first without a word. Any other module wiring one
 * would silently switch the bridge off.
 */
describe("webRequest listeners are registered in engine-origin.ts alone", () => {
	function sources(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sources(path);
			return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
		});
	}

	it("finds no registration in any other main-process module", () => {
		const files = sources(electronDir);
		const registering = files
			.filter((file) =>
				/\.on(BeforeRequest|BeforeSendHeaders|SendHeaders|HeadersReceived|ResponseStarted|BeforeRedirect|Completed|ErrorOccurred)\(/.test(
					readFileSync(file, "utf8")
				)
			)
			.map((file) => relative(electronDir, file));

		// Scanned something real, and the scan sees the registrations it exists for.
		expect(files.length).toBeGreaterThan(30);
		expect(registering).toEqual(["engine-origin.ts"]);
	});
});
