/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth 2.0 interactive-flow IPC.
 *
 * The engine owns PKCE, state, the loopback listener, and the token exchange
 * (see engine/src/http/routes/oauth_authorize.cpp). Electron only:
 *   - opens the authorize URL in the system browser (loopback mode), or
 *   - hosts a hardened window that captures the redirect URL (embedded mode)
 *     for providers that reject 127.0.0.1 redirects.
 * Electron never sees tokens - only the authorization code, which it hands
 * straight back to the engine.
 */

import { ipcMain, shell, BrowserWindow } from "electron";
import { createAuthWindowFlow, type AuthWindowResult } from "./oauth-window.js";
import { isBrowsableUrl, urlProtocol } from "./external-url.js";

export interface OpenAuthWindowParams {
	authorizeUrl: string;
	redirectUri: string;
	/** Session partition so different logins don't share cookies. */
	partition?: string;
}

export type OpenAuthWindowResult = AuthWindowResult;

/**
 * Open a hardened window at the authorize URL and resolve with the redirect URL
 * the moment the IdP navigates to it - before the (often unresolvable) callback
 * host is ever contacted.
 *
 * Everything about *when* this settles lives in `oauth-window.ts`; this function
 * is only the Electron window it settles for.
 */
function openAuthWindow(params: OpenAuthWindowParams): Promise<OpenAuthWindowResult> {
	const win = new BrowserWindow({
		width: 520,
		height: 680,
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			partition: params.partition ?? "oauth:default",
		},
	});

	// The IdP page is untrusted: never let it spawn child windows that could
	// escape the redirect matcher in the flow.
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	const flow = createAuthWindowFlow(params, {
		loadUrl: (url) => win.loadURL(url),
		destroy: () => {
			if (win.isDestroyed()) return;
			win.webContents.removeAllListeners();
			win.removeAllListeners("closed");
			win.destroy();
		},
		schedule: (listener, ms) => {
			const timer = setTimeout(listener, ms);
			return () => clearTimeout(timer);
		},
	});

	win.webContents.on("will-redirect", (e, url) => {
		if (flow.onNavigate(url)) e.preventDefault();
	});
	win.webContents.on("did-start-navigation", (_e, url) => flow.onNavigate(url));
	win.webContents.on("did-navigate", (_e, url) => flow.onNavigate(url));
	// Only the main frame decides the flow; a subframe on the IdP page failing
	// to load is the IdP's problem, not an authorization failure.
	win.webContents.on("did-fail-load", (_e, errorCode, errorDescription, _url, isMainFrame) => {
		if (isMainFrame) flow.onLoadFailure(errorCode, errorDescription);
	});
	win.once("ready-to-show", () => win.show());
	win.on("closed", () => flow.onClosed());

	flow.start();
	return flow.result;
}

export function setupOAuthIpcHandlers(): void {
	// Loopback mode: open the system browser (engine hosts the callback listener).
	// Only http(s) is ever a valid authorize URL - reject anything else so a
	// compromised renderer can't hand arbitrary protocol handlers to the OS. The
	// rule itself lives in external-url.ts, shared with the context menu's "Open
	// in Browser", which asks the same question of an arbitrary `href`.
	ipcMain.handle("shell:openExternalUrl", async (_e, url: string) => {
		const scheme = urlProtocol(url);
		if (scheme === null) {
			throw new Error("Invalid authorize URL");
		}
		if (!isBrowsableUrl(url)) {
			throw new Error(`Refusing to open non-HTTP(S) URL: ${scheme}`);
		}
		await shell.openExternal(url);
	});

	// Embedded mode: capture the redirect URL and return it to the renderer.
	ipcMain.handle(
		"oauth:openWindow",
		async (_e, params: OpenAuthWindowParams): Promise<OpenAuthWindowResult> => {
			return openAuthWindow(params);
		}
	);
}
