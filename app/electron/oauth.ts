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

export interface OpenAuthWindowParams {
	authorizeUrl: string;
	redirectUri: string;
	/** Session partition so different logins don't share cookies. */
	partition?: string;
}

export type OpenAuthWindowResult = { callbackUrl: string } | { error: string };

/**
 * Open a hardened window at the authorize URL and resolve with the redirect URL
 * the moment the IdP navigates to it - before the (often unresolvable) callback
 * host is ever contacted.
 */
function openAuthWindow(params: OpenAuthWindowParams): Promise<OpenAuthWindowResult> {
	return new Promise((resolve) => {
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
		// escape the redirect matcher below.
		win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

		let settled = false;
		const callbackPrefix = params.redirectUri.split("?")[0];

		const finish = (result: OpenAuthWindowResult) => {
			if (settled) return;
			settled = true;
			if (!win.isDestroyed()) {
				win.webContents.removeAllListeners();
				win.removeAllListeners("closed");
				win.destroy();
			}
			resolve(result);
		};

		// Match the registered callback URL AND require an OAuth indicator, so we
		// don't fire on intermediate IdP pages sharing the prefix (Bruno's rule).
		const matches = (url: string) =>
			url.startsWith(callbackPrefix) &&
			(url.includes("code=") || url.includes("error=") || url.includes("#"));

		const onNav = (url: string) => {
			if (matches(url)) {
				finish({ callbackUrl: url });
				return true;
			}
			return false;
		};

		win.webContents.on("will-redirect", (e, url) => {
			if (onNav(url)) e.preventDefault();
		});
		win.webContents.on("did-start-navigation", (_e, url) => onNav(url));
		win.webContents.on("did-navigate", (_e, url) => onNav(url));
		win.once("ready-to-show", () => win.show());
		win.on("closed", () => finish({ error: "Authorization window was closed" }));

		void win.loadURL(params.authorizeUrl).catch(() => {
			/* navigation to the fake callback host is expected to fail; ignore */
		});
	});
}

export function setupOAuthIpcHandlers(): void {
	// Loopback mode: open the system browser (engine hosts the callback listener).
	// Only http(s) is ever a valid authorize URL - reject anything else so a
	// compromised renderer can't hand arbitrary protocol handlers to the OS.
	ipcMain.handle("oauth:openExternal", async (_e, url: string) => {
		let scheme: string;
		try {
			scheme = new URL(url).protocol;
		} catch {
			throw new Error("Invalid authorize URL");
		}
		if (scheme !== "http:" && scheme !== "https:") {
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
