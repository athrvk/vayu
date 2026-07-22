/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Electron preload script
// This file runs in the renderer process before web content begins loading
// NOTE: Preload scripts with contextIsolation must use require() syntax

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
	// Engine management
	restartEngine: (): Promise<{ success: boolean; error?: string }> =>
		ipcRenderer.invoke("engine:restart"),
	getEngineStatus: (): Promise<{ running: boolean; url: string | null }> =>
		ipcRenderer.invoke("engine:status"),

	// MCP server (exposes Vayu to agents like Claude Code). See electron/mcp/.
	getMcpStatus: (): Promise<{ running: boolean; url: string; enabled: boolean }> =>
		ipcRenderer.invoke("mcp:status"),
	getMcpSafety: () => ipcRenderer.invoke("mcp:getSafety"),
	getMcpTools: () => ipcRenderer.invoke("mcp:getTools"),
	updateMcpSafety: (partial: unknown) => ipcRenderer.invoke("mcp:updateSafety", partial),
	setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke("mcp:setEnabled", enabled),
	connectMcpClient: (client: "claude" | "vscode") =>
		ipcRenderer.invoke("mcp:connectClient", client),

	// Theme management
	getTheme: (): Promise<{ shouldUseDarkColors: boolean; themeSource: string }> =>
		ipcRenderer.invoke("theme:get"),
	setTheme: (
		source: "system" | "light" | "dark"
	): Promise<{ shouldUseDarkColors: boolean; themeSource: string }> =>
		ipcRenderer.invoke("theme:set", source),
	onThemeChanged: (
		callback: (theme: { shouldUseDarkColors: boolean; themeSource: string }) => void
	) => {
		const handler = (
			_event: unknown,
			theme: { shouldUseDarkColors: boolean; themeSource: string }
		) => callback(theme);
		ipcRenderer.on("theme:changed", handler);
		return () => ipcRenderer.removeListener("theme:changed", handler);
	},

	// Window controls for custom titlebar
	windowMinimize: () => ipcRenderer.send("window:minimize"),
	windowMaximize: () => ipcRenderer.send("window:maximize"),
	windowClose: () => ipcRenderer.send("window:close"),
	windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => {
		const handler = (_event: unknown, isMaximized: boolean) => callback(isMaximized);
		ipcRenderer.on("window:maximized", handler);
		return () => ipcRenderer.removeListener("window:maximized", handler);
	},

	// Auto-update
	onUpdateAvailable: (
		callback: (info: {
			version: string;
			strategy: "silent" | "notify" | "disabled";
			releaseUrl: string;
			installCommand?: string;
		}) => void
	) => {
		const handler = (_event: unknown, info: unknown) =>
			callback(info as Parameters<typeof callback>[0]);
		ipcRenderer.on("update:available", handler);
		return () => ipcRenderer.removeListener("update:available", handler);
	},
	onUpdateDownloaded: (callback: (info: { version: string }) => void) => {
		const handler = (_event: unknown, info: { version: string }) => callback(info);
		ipcRenderer.on("update:downloaded", handler);
		return () => ipcRenderer.removeListener("update:downloaded", handler);
	},
	restartToInstallUpdate: (): Promise<void> => ipcRenderer.invoke("update:restartToInstall"),
	// Shape mirrors `UpdateCheckResult` in updater.ts, inlined because this file
	// is a CommonJS script and must not grow imports.
	checkForUpdates: (): Promise<
		| { status: "unavailable"; detail: string }
		| { status: "up-to-date"; version: string }
		| {
				status: "available";
				version: string;
				strategy: "silent" | "notify" | "disabled";
				releaseUrl: string;
				installCommand?: string;
		  }
		| { status: "error"; message: string }
	> => ipcRenderer.invoke("update:check"),
	openReleasePage: (url: string): Promise<void> =>
		ipcRenderer.invoke("update:openReleasePage", url),

	// Menu-driven navigation
	onOpenSettings: (callback: () => void) => {
		const handler = () => callback();
		ipcRenderer.on("menu:open-settings", handler);
		return () => ipcRenderer.removeListener("menu:open-settings", handler);
	},

	// Interface scale - real page zoom (reflows the viewport).
	setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),
	getZoomFactor: (): number => webFrame.getZoomFactor(),

	// Platform info
	platform: process.platform,

	// Open one of the app's own doc links in the system browser. Keyed, not
	// URL-taking - see the handler in main.ts.
	openAppLink: (key: "docs" | "scripting" | "issues"): Promise<void> =>
		ipcRenderer.invoke("shell:openAppLink", key),

	// OAuth 2.0 interactive flow
	oauthOpenExternal: (url: string): Promise<void> =>
		ipcRenderer.invoke("oauth:openExternal", url),
	oauthOpenWindow: (params: {
		authorizeUrl: string;
		redirectUri: string;
		partition?: string;
	}): Promise<{ callbackUrl: string } | { error: string }> =>
		ipcRenderer.invoke("oauth:openWindow", params),

	// App paths
	getAppPaths: (): Promise<{
		appDir: string;
		dataDir: string;
		logsPath: string;
		dbPath: string;
	}> => ipcRenderer.invoke("app:getPaths"),

	// Before quit flush handler. ACKs main once the callback settles so quit
	// can resume immediately instead of waiting out the fallback timeout.
	onBeforeQuit: (callback: () => void | Promise<void>) => {
		const handler = async () => {
			try {
				await callback();
			} finally {
				ipcRenderer.send("before-quit-flushed");
			}
		};
		ipcRenderer.on("before-quit", handler);
		return () => ipcRenderer.removeListener("before-quit", handler);
	},
});

window.addEventListener("DOMContentLoaded", () => {
	console.log("Vayu loaded");
});
