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
				"collection" | "request" | "environment" | "run" | "cookie" | "config" | "service";
			collectionId?: string;
			requestId?: string;
			runId?: string;
			inboxId?: string;
			mockId?: string;
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
	// Windows and Linux: pops the application menu the main process already
	// installed, which a frameless window draws no bar for (#1361).
	windowAppMenu: (position?: { x: number; y: number }): void =>
		ipcRenderer.send("window:appMenu", position),
	onWindowMaximized: (callback: (isMaximized: boolean) => void) => {
		const handler = (_event: unknown, isMaximized: boolean) => callback(isMaximized);
		ipcRenderer.on("window:maximized", handler);
		return () => ipcRenderer.removeListener("window:maximized", handler);
	},

	// Context menu (#1359). The main process composes it from Chromium's own
	// editing state; these two carry the half only the renderer knows.
	//
	// Synchronous, and deliberately the only `sendSync` in the app: this is
	// called from a `contextmenu` listener, and blocking there until the main
	// process has the announcement is what pairs it with the `context-menu`
	// event that follows. The shape mirrors `ContextTarget` in
	// electron/context-menu.ts, inlined because this file is a CommonJS script
	// and must not grow imports.
	setContextTarget: (target: {
		kind: "url-bar" | "monaco" | null;
		variable: string | null;
	}): void => {
		ipcRenderer.sendSync("context-menu:target", target);
	},
	// The two menu offers the renderer owns: importing a curl or wget command
	// from the clipboard, and opening a `{{token}}`'s popover. Mirrors the
	// forwarded half of `ContextCommand` in electron/context-menu.ts.
	onContextMenuCommand: (
		callback: (
			command:
				{ type: "import-command"; text: string } | { type: "edit-variable"; name: string }
		) => void
	) => {
		const handler = (_event: unknown, command: unknown) =>
			callback(command as Parameters<typeof callback>[0]);
		ipcRenderer.on("context-menu:command", handler);
		return () => ipcRenderer.removeListener("context-menu:command", handler);
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

	// View → Back / Forward, the mouse's back/forward buttons as the OS reports
	// them, and the macOS swipe. The renderer owns the history these step
	// through - see nav-history.ts and stores/tabs-store.ts.
	onNavigateHistory: (callback: (direction: "back" | "forward") => void) => {
		const handler = (_event: unknown, direction: "back" | "forward") => callback(direction);
		ipcRenderer.on("menu:navigate", handler);
		return () => ipcRenderer.removeListener("menu:navigate", handler);
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

	// Re-resolve the operating system's proxy and push it to the engine (#708).
	// The renderer asks for this when it has reason to think the answer moved -
	// the browser's own `online` event, or a user arriving at the network
	// settings - and the main process, which owns the only Chromium session
	// that can answer, does the resolving. Resolves to the proxy URL now in
	// force, "" for a direct configuration, or null when it could not be asked.
	refreshSystemProxy: (): Promise<string | null> => ipcRenderer.invoke("proxy:refreshSystem"),

	// System wake lock, held while a run streams (#1357). Token-based: the main
	// process ref-counts the holds and only the token taken here releases one, so
	// two overlapping runs cannot drop each other's lock. Main also drops a
	// renderer's holds when it goes away or reloads, which is the case a token
	// cannot cover.
	holdWakeLock: (reason: string): Promise<string> => ipcRenderer.invoke("power:hold", reason),
	releaseWakeLock: (token: string): Promise<boolean> =>
		ipcRenderer.invoke("power:release", token),
	// The host slept anyway - lid closed, battery critical, a user who forced it.
	// The lock is a request to the OS, not a guarantee, so the run's series can
	// still have a gap; these two say where it is. Sent only while a run holds.
	onHostSuspended: (callback: (event: { at: number }) => void) => {
		const handler = (_event: unknown, payload: { at: number }) => callback(payload);
		ipcRenderer.on("power:suspended", handler);
		return () => ipcRenderer.removeListener("power:suspended", handler);
	},
	onHostResumed: (callback: (event: { at: number; durationMs: number }) => void) => {
		const handler = (_event: unknown, payload: { at: number; durationMs: number }) =>
			callback(payload);
		ipcRenderer.on("power:resumed", handler);
		return () => ipcRenderer.removeListener("power:resumed", handler);
	},

	// A run's progress on the taskbar button and the Dock icon (#1362). One-way
	// and unacknowledged: this is painted at most twice a second off the metrics
	// flush, an answer would tell the renderer nothing it acts on, and a run must
	// never wait on the OS to draw. `value` is null for a run with no
	// denominator; main decides what each platform makes of that.
	setRunProgress: (update: {
		state: "running" | "failed" | "idle";
		value?: number | null;
	}): void => ipcRenderer.send("runs:progress", update),

	// What the Dock and taskbar icon carries, and what its menu offers (#1364).
	// One-way for the same reason as the progress bar: nothing the OS answers
	// would change what the renderer does. The renderer reports what happened -
	// a capture landed, the Inbox was opened, a run failed, these are the
	// collections it has been in - and main decides whether the user is looking
	// and what this platform can show. The shapes mirror `OsIconSignal` in
	// `electron/os-icon.ts`, inlined because this file is a CommonJS script and
	// must not grow imports.
	setOsIconSignal: (
		signal:
			| { kind: "captured" }
			| { kind: "inboxOpened" }
			| { kind: "runFailed" }
			| { kind: "runFinished" }
			| { kind: "recents"; collections: Array<{ id: string; name: string }> }
	): void => ipcRenderer.send("icon:signal", signal),

	// Something the OS asked Vayu to open (#1364): a document dropped on the
	// icon, an entry picked off the icon's menu, or a Jump List task. Main
	// buffers these until this callback exists, so a cold launch's file is not
	// lost to the window that was not up yet.
	onOpenIntent: (
		callback: (
			intent:
				| { kind: "import"; path: string }
				| { kind: "collection"; collectionId: string }
				| { kind: "newRequest" }
		) => void
	) => {
		const handler = (
			_event: unknown,
			payload:
				| { kind: "import"; path: string }
				| { kind: "collection"; collectionId: string }
				| { kind: "newRequest" }
		) => callback(payload);
		ipcRenderer.on("intent:open", handler);
		return () => ipcRenderer.removeListener("intent:open", handler);
	},

	// What the engine is holding for this window - inboxes, mock servers, mock
	// issuers (#1363). Sent on every change so the close that would stop them can
	// name them without asking anything while the user waits; the shape mirrors
	// `RunningService` in `electron/service-stop-guard.ts`, inlined because this
	// file is a CommonJS script and must not grow imports.
	setRunningServices: (
		services: Array<{
			kind: "inbox" | "mock-server" | "issuer";
			name: string | null;
			port: number;
		}>
	): void => ipcRenderer.send("services:running", services),

	// System notifications for what finishes while the user is elsewhere
	// (#1358). The renderer sends what happened; main decides whether to post
	// it - the window's focus and the platform's support are its to answer -
	// and resolves with what became of it. `notificationAvailability` is what
	// the settings row asks before saying the toggle works on this build: a
	// macOS bundle the OS will not authorize cannot show one, and says so after
	// the first try.
	showNotification: (request: {
		kind: string;
		title: string;
		body: string;
		target:
			| { view: "run"; runId: string }
			| { view: "inbox"; inboxId: string }
			| { view: "settings" }
			| { view: "app" };
	}): Promise<string> => ipcRenderer.invoke("notify:show", request),
	notificationAvailability: (): Promise<{ available: boolean; reason: string | null }> =>
		ipcRenderer.invoke("notify:availability"),
	// Post one on purpose, from the settings row. Unlike every other path this
	// one ignores both the focus check and the opt-in - the user is looking at
	// the panel when they press it, and a test is how they decide whether to
	// turn the setting on. Resolves with what the OS did, not with what was
	// attempted: a refusal arrives after the call and is what this waits for.
	sendTestNotification: (): Promise<string> => ipcRenderer.invoke("notify:test"),
	// A notification was clicked. Carries what it was about, so the renderer can
	// open it - main has no opinion about the app's own surfaces.
	onNotificationActivated: (
		callback: (event: {
			kind: string;
			target:
				| { view: "run"; runId: string }
				| { view: "inbox"; inboxId: string }
				| { view: "settings" }
				| { view: "app" };
		}) => void
	) => {
		const handler = (
			_event: unknown,
			payload: {
				kind: string;
				target:
					| { view: "run"; runId: string }
					| { view: "inbox"; inboxId: string }
					| { view: "settings" }
					| { view: "app" };
			}
		) => callback(payload);
		ipcRenderer.on("notify:activated", handler);
		return () => ipcRenderer.removeListener("notify:activated", handler);
	},

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
