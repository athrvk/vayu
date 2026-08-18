/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Electron preload script
// This file runs in the renderer process before web content begins loading
// NOTE: Preload scripts with contextIsolation must use require() syntax - the
// script is loaded as CommonJS in the isolated world, so an ESM `import` here
// fails at runtime. That is the boundary the rule below cannot see.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer, webFrame, webUtils } = require("electron");

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
	// Engine management
	restartEngine: (): Promise<{ success: boolean; error?: string }> =>
		ipcRenderer.invoke("engine:restart"),

	// MCP server (exposes Vayu to agents like Claude Code). See electron/mcp/.
	getMcpStatus: (): Promise<{ running: boolean; url: string; enabled: boolean }> =>
		ipcRenderer.invoke("mcp:status"),
	getMcpSafety: () => ipcRenderer.invoke("mcp:getSafety"),
	getMcpTools: () => ipcRenderer.invoke("mcp:getTools"),
	updateMcpSafety: (partial: unknown) => ipcRenderer.invoke("mcp:updateSafety", partial),
	setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke("mcp:setEnabled", enabled),
	connectMcpClient: (client: "claude" | "vscode") =>
		ipcRenderer.invoke("mcp:connectClient", client),
	// An agent's write reached the engine from the main process, so the renderer
	// is told which data family to invalidate. One-way and data-free; the shape
	// mirrors `McpDataChangedEvent` in electron/mcp/tools.ts, inlined because
	// this file is a CommonJS script and must not grow imports.
	onMcpDataChanged: (
		callback: (event: {
			entity:
				| "collection"
				| "request"
				| "environment"
				| "run"
				| "cookie"
				| "config"
				| "service";
			collectionId?: string;
			requestId?: string;
			runId?: string;
			inboxId?: string;
		}) => void
	) => {
		const handler = (_event: unknown, change: unknown) =>
			callback(change as Parameters<typeof callback>[0]);
		ipcRenderer.on("mcp:data-changed", handler);
		return () => ipcRenderer.removeListener("mcp:data-changed", handler);
	},

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
	// Windows only: pops the app-icon system menu. See the handler in main.ts for
	// why this is reimplemented rather than left to the platform.
	windowSystemMenu: (position?: { x: number; y: number }): void =>
		ipcRenderer.send("window:systemMenu", position),
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
	// macOS notify path: the installer needs Vayu closed before it can replace
	// the bundle, and quitting from in here skips the Automation consent prompt
	// a terminal would hit.
	quitForUpdate: (): Promise<void> => ipcRenderer.invoke("update:quitForUpdate"),

	// Menu-driven navigation
	onOpenSettings: (callback: () => void) => {
		const handler = () => callback();
		ipcRenderer.on("menu:open-settings", handler);
		return () => ipcRenderer.removeListener("menu:open-settings", handler);
	},

	// Interface scale - real page zoom (reflows the viewport).
	setZoomFactor: (factor: number) => webFrame.setZoomFactor(factor),

	// View → Zoom In / Zoom Out / Actual Size. The menu items carry no zoom of
	// their own: they ask the renderer to move its persisted interface-scale
	// setting, which is what then applies the zoom. Without that indirection the
	// accelerators compounded Chromium zoom on top of the setting and were lost
	// on the next launch.
	onZoomCommand: (callback: (command: "in" | "out" | "reset") => void) => {
		const handler = (_event: unknown, command: "in" | "out" | "reset") => callback(command);
		ipcRenderer.on("menu:zoom", handler);
		return () => ipcRenderer.removeListener("menu:zoom", handler);
	},

	// Platform info
	platform: process.platform,

	// Open one of the app's own doc links in the system browser. Keyed, not
	// URL-taking - see the handler in main.ts.
	openAppLink: (key: "docs" | "scripting" | "issues"): Promise<void> =>
		ipcRenderer.invoke("shell:openAppLink", key),

	// Open an arbitrary http(s) URL in the system browser. The main handler
	// validates the scheme and refuses everything else, so this does not hand the
	// web layer a general "launch any protocol handler" capability.
	//
	// Used by the OAuth authorize flow and by links inside rendered markdown -
	// the latter being why it is no longer named after OAuth.
	openExternalUrl: (url: string): Promise<void> =>
		ipcRenderer.invoke("shell:openExternalUrl", url),

	// OAuth 2.0 interactive flow
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

	// The absolute path of a `File` the user picked, for a multipart file part:
	// the engine opens the file itself, so the renderer needs its path and never
	// its bytes. `File.path` was removed in Electron 32 and `webUtils` is the
	// replacement - it is synchronous and local to the preload, so this is not
	// an IPC channel and grants the renderer no ability to name paths of its
	// own. Empty when the object is not a real file (a drag-and-drop of remote
	// content), which the caller reports rather than sending a phantom path.
	getFilePath: (file: File): string => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},

	// Re-read a collection's declared data file by path (issue #599) - the one
	// channel on which the renderer *does* name a path, because the Run dialog
	// has to re-open a file the user picked in an earlier session and the `File`
	// is long gone. Gated in the main process (extension allowlist + the
	// engine's fetched byte cap); see electron/data-file.ts for why that gate is
	// the whole answer. Bytes, not text: the renderer decodes with the same
	// module the picker uses, so the two paths cannot disagree about a file.
	readDataFile: (path: string): Promise<{ bytes: Uint8Array; fileName: string }> =>
		ipcRenderer.invoke("dataFile:read", path),

	// Read a file an imported OpenAPI document references (issue #649). Two
	// arguments and not a composed path: the renderer holds the picked
	// document's path and the ref's text, and the main process resolves one
	// against the other, so this channel reads files a *document* named rather
	// than paths the web layer built. Gated there (extension allowlist + the
	// engine's fetched `maxSpecDocumentBytes`); bytes, not text, for the same
	// reason `readDataFile` returns bytes.
	readSpecFile: (
		specPath: string,
		refPath: string
	): Promise<{ bytes: Uint8Array; fileName: string }> =>
		ipcRenderer.invoke("specFile:read", specPath, refPath),

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
