/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	nativeTheme,
	Menu,
	powerMonitor,
	session,
	shell,
} from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { EngineSidecar, EngineNotReadyError } from "./sidecar.js";
import { resolveAppPaths } from "./app-paths.js";
import { readDataFile } from "./data-file.js";
import { readSpecFile } from "./spec-file.js";
import {
	defaultProxyResolutionSystem,
	refreshSystemProxy,
	type ProxyResolutionSystem,
} from "./proxy-resolution.js";
import { setupOAuthIpcHandlers } from "./oauth.js";
import { loadWindowState, trackWindowState } from "./window-state.js";
import { initAutoUpdater, checkForUpdatesNow, disposeAutoUpdater } from "./updater.js";
import { installQuitOnSignal } from "./quit-signals.js";
import { installWindowNavigationGuard } from "./window-navigation.js";
import { createSaveFlusher } from "./save-flush.js";
import { createRendererRecovery } from "./renderer-recovery.js";
import { createQuitShutdown } from "./quit-shutdown.js";
import { stampInstalledVersion } from "./appimage-stamp.js";
/*
 * MCP is imported by weight, not through its barrel.
 *
 * `mcp/index.js` re-exports `toolCatalog` from the 7,300-line tool registry and
 * constructs its facade over `http.js`, so importing *anything* runtime from it
 * evaluates the MCP SDK, zod and all 67 tool schemas - ~250-300ms of serial
 * main-process evaluation, before `app.whenReady` and therefore ahead of the
 * window, on every launch including the ones where MCP is switched off.
 *
 * `config`, `store` and `connect` reach none of that (`electron-store` and
 * `node:child_process` are their heaviest dependencies), so the startup gate and
 * the Settings IPC read them directly and for free. The two symbols that do pull
 * the SDK - the service and the tool catalog - are loaded on demand by
 * `loadMcp()` below.
 */
import { resolveSafetyConfig, sanitizeSafetyInput, type McpSafetyConfig } from "./mcp/config.js";
import {
	loadPersistedSafety,
	savePersistedSafety,
	effectiveSafety,
	loadMcpEnabled,
	saveMcpEnabled,
} from "./mcp/store.js";
import { connectClient, type McpConnectClient } from "./mcp/connect.js";
import type { McpDataChangedEvent } from "./mcp/tools.js";
import type { VayuMcpService } from "./mcp/index.js";
import {
	DOCS_URL,
	SCRIPTING_DOCS_URL,
	ISSUES_URL,
	DEV_SERVER_URL,
	WINDOW_DEFAULT_WIDTH,
	WINDOW_DEFAULT_HEIGHT,
	WINDOW_MIN_WIDTH,
	WINDOW_MIN_HEIGHT,
	TITLEBAR_HEIGHT,
	TRAFFIC_LIGHT_X,
	TRAFFIC_LIGHT_FRAME_HEIGHT,
	TITLEBAR_BG_LIGHT,
	TITLEBAR_BG_DARK,
	TITLEBAR_FG_LIGHT,
	TITLEBAR_FG_DARK,
	WINDOW_BG_LIGHT,
	WINDOW_BG_DARK,
	ENGINE_HOST,
	ENGINE_PORT,
	MCP_HOST,
	MCP_PORT,
	MCP_ENDPOINT_URL,
} from "./constants.js";

const isDev = process.env.NODE_ENV === "development";

// Use an in-memory mock keychain for Chromium's OSCrypt instead of the real
// macOS Keychain. Without this, Chromium stores its cookie/safeStorage
// encryption key under a "Vayu Safe Storage" Keychain item, which re-prompts
// for the user's password on every launch because the app is ad-hoc signed
// (see install.sh) and has no stable code signature to anchor the Keychain
// ACL to. Vayu keeps all secrets in plaintext SQLite and does not rely on
// persistent cookies, so the static mock key costs no real protection here.
// Must be set before app is ready. Revisit if the app ever ships with a
// Developer ID signature (then "Always Allow" would persist on its own).
app.commandLine.appendSwitch("use-mock-keychain");

// __dirname is not defined in ES modules. Derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global sidecar instance
let engineSidecar: EngineSidecar | null = null;
// MCP server (Streamable HTTP) exposing the engine to agents. See mcp/index.ts.
let mcpService: VayuMcpService | null = null;
let mainWindow: BrowserWindow | null = null;

/** The window as it is right now, or null if there isn't a usable one. */
function liveWindow(): BrowserWindow | null {
	return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Show a recovery dialog on the window, and answer with the button index. */
async function askOnWindow(options: Electron.MessageBoxOptions): Promise<number> {
	const win = liveWindow();
	const { response } = await (win
		? dialog.showMessageBox(win, options)
		: dialog.showMessageBox(options));
	return response;
}

// Shared by the quit path and the window-close path - see save-flush.ts for why
// there is only one of these.
const saveFlusher = createSaveFlusher({
	requestFlush: () => {
		if (!mainWindow || mainWindow.webContents.isDestroyed()) return false;
		// A dead renderer's WebContents object outlives the process it drove, so
		// `isDestroyed()` above stays false and this would ask for an ACK that
		// can never come - the whole 2s ceiling, on a window whose unsaved work
		// died with the process. See renderer-recovery.ts.
		if (rendererRecovery.isRendererGone()) return false;
		mainWindow.webContents.send("before-quit");
		return true;
	},
	onFlushed: (listener) => {
		ipcMain.once("before-quit-flushed", listener);
		return () => ipcMain.removeListener("before-quit-flushed", listener);
	},
	schedule: (listener, ms) => {
		setTimeout(listener, ms);
	},
});

// Reloading the window when its renderer dies, and asking when reloading is not
// working. Module-level and reading `mainWindow` at use time for the reason the
// updater does: on macOS the app outlives its window and a dock-activate builds
// a replacement, which a captured reference would never reach. The crash
// history is deliberately kept across that, so a crash loop that takes the
// window with it is still a loop.
const rendererRecovery = createRendererRecovery({
	now: () => Date.now(),
	reload: () => liveWindow()?.webContents.reload(),
	promptCrashLoop: async (details) => {
		const choice = await askOnWindow({
			type: "error",
			message: "Vayu keeps crashing",
			detail:
				`The window stopped working repeatedly (${details.reason}, exit code ` +
				`${details.exitCode}) and reloading has not helped. Relaunching Vayu ` +
				`may clear it. Unsaved changes in the window are already lost.`,
			buttons: ["Relaunch", "Quit"],
			defaultId: 0,
			cancelId: 1,
		});
		return choice === 0 ? "relaunch" : "quit";
	},
	promptUnresponsive: async () => {
		const choice = await askOnWindow({
			type: "warning",
			message: "Vayu is not responding",
			detail:
				"The window has stopped responding. Waiting may let it catch up; " +
				"reloading discards anything it has not saved yet.",
			buttons: ["Wait", "Reload"],
			defaultId: 0,
			cancelId: 0,
		});
		return choice === 1 ? "reload" : "wait";
	},
	relaunch: () => {
		app.relaunch();
		app.quit();
	},
	quit: () => app.quit(),
	// The dead renderer's flush settled against nobody; the live one that
	// replaced it has its own unsaved work and must be asked.
	onRecovered: () => saveFlusher.reset(),
});

/**
 * Forward OS theme changes to whichever window is up.
 *
 * Installed once for the process, not per window: `nativeTheme` is a
 * process-wide emitter and `createWindow()` runs again on every macOS
 * dock-reopen, so registering there left one listener per reopen - Node warns
 * at eleven, and every theme flip sent the renderer N copies of the same event.
 * Reading the window through `liveWindow()` at send time is what makes one
 * registration enough for every window that follows.
 */
function installThemeBridge() {
	nativeTheme.on("updated", () => {
		const win = liveWindow();
		win?.webContents.send("theme:changed", {
			shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
			themeSource: nativeTheme.themeSource,
		});

		// Update titlebar overlay color - Windows only
		if (process.platform === "win32" && win) {
			win.setTitleBarOverlay({
				color: nativeTheme.shouldUseDarkColors ? TITLEBAR_BG_DARK : TITLEBAR_BG_LIGHT,
				symbolColor: nativeTheme.shouldUseDarkColors ? TITLEBAR_FG_DARK : TITLEBAR_FG_LIGHT,
				height: TITLEBAR_HEIGHT,
			});
		}
	});
}

function createWindow() {
	// A new window means a new renderer with its own unsaved work. Told to the
	// recovery first, so a crash flag left over from the window this one
	// replaces cannot make the new renderer look unreachable.
	rendererRecovery.noteRendererAlive();
	saveFlusher.reset();

	// Load persisted window state
	const windowState = loadWindowState({
		defaultWidth: WINDOW_DEFAULT_WIDTH,
		defaultHeight: WINDOW_DEFAULT_HEIGHT,
	});

	mainWindow = new BrowserWindow({
		width: windowState.width,
		height: windowState.height,
		x: windowState.x,
		y: windowState.y,
		minWidth: WINDOW_MIN_WIDTH,
		minHeight: WINDOW_MIN_HEIGHT,
		// Custom titlebar settings
		frame: false,
		titleBarStyle: "hidden",
		// Centre the macOS traffic lights in the bar. The frame height is a named
		// constant because it has been wrong twice: 16 originally, then 12 (the
		// visible circle) - Electron positions the button frame, which is 14.
		trafficLightPosition:
			process.platform === "darwin"
				? {
						x: TRAFFIC_LIGHT_X,
						y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_FRAME_HEIGHT) / 2),
					}
				: undefined,
		// Windows-only native overlay - Linux uses custom HTML buttons
		titleBarOverlay:
			process.platform === "win32"
				? {
						color: nativeTheme.shouldUseDarkColors
							? TITLEBAR_BG_DARK
							: TITLEBAR_BG_LIGHT,
						symbolColor: nativeTheme.shouldUseDarkColors
							? TITLEBAR_FG_DARK
							: TITLEBAR_FG_LIGHT,
						height: TITLEBAR_HEIGHT,
					}
				: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js"),
		},
		title: "Vayu",
		backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BG_DARK : WINDOW_BG_LIGHT,
		show: false, // Don't show until ready
	});

	// Track window state for persistence
	trackWindowState(mainWindow);

	// Restore maximized state
	if (windowState.isMaximized) {
		mainWindow.maximize();
	}

	// Show window when ready to prevent visual flash
	mainWindow.once("ready-to-show", () => {
		mainWindow?.show();
	});

	// The preload re-runs on whatever this window navigates to, so a navigation
	// off the app hands `window.electronAPI` to that origin. Installed before the
	// load, so no navigation can land ahead of the guard. See
	// window-navigation.ts.
	const rendererEntry = path.join(__dirname, "../dist/index.html");
	installWindowNavigationGuard(
		mainWindow.webContents,
		isDev ? DEV_SERVER_URL : pathToFileURL(rendererEntry).toString()
	);

	if (isDev) {
		mainWindow.loadURL(DEV_SERVER_URL);
		// mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(rendererEntry);
	}

	mainWindow.on("page-title-updated", (event) => {
		event.preventDefault();
	});

	// Nothing recovers a gone renderer on its own: the window stays up, blank
	// and frozen, and the close path waits out the flush ceiling asking a
	// process that no longer exists. See renderer-recovery.ts.
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		rendererRecovery.handleRenderProcessGone(details);
	});
	mainWindow.webContents.on("did-finish-load", () => {
		rendererRecovery.noteRendererAlive();
	});
	mainWindow.on("unresponsive", () => {
		rendererRecovery.handleUnresponsive();
	});
	mainWindow.on("responsive", () => {
		rendererRecovery.handleResponsive();
	});

	// The X button destroys the renderer before `before-quit` can ask it for
	// anything (and on macOS it never quits at all), so the flush has to happen
	// here. Bound to this window rather than to `mainWindow`, which may point at
	// a replacement by the time the flush lands.
	//
	// Gated on settled, not on requested: an X click landing while a quit's
	// flush is still in flight must not destroy the renderer mid-write. In that
	// state the flush below joins the round trip already out and closes the
	// window when it settles.
	const closingWindow = mainWindow;
	closingWindow.on("close", (event) => {
		if (saveFlusher.hasSettled()) return;
		event.preventDefault();
		saveFlusher.flush(() => {
			if (!closingWindow.isDestroyed()) closingWindow.close();
		});
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

/** Ask the renderer to open the Settings view (from the menu / ⌘,). */
function openSettings() {
	mainWindow?.webContents.send("menu:open-settings");
}

/**
 * Ask the renderer to move its interface-scale setting (View → zoom, Ctrl+±/0).
 *
 * Deliberately not the `zoomIn`/`zoomOut`/`resetZoom` roles: those drive
 * Chromium's zoom directly, which compounded on top of the saved scale, was
 * never persisted, and made `resetZoom` snap to 100% in defiance of the user's
 * setting. The renderer owns the value, so the menu only nudges it.
 */
function sendZoomCommand(command: "in" | "out" | "reset") {
	mainWindow?.webContents.send("menu:zoom", command);
}

function createMenu() {
	const isMac = process.platform === "darwin";

	const template: Electron.MenuItemConstructorOptions[] = [
		// App menu (macOS only)
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const },
							{ type: "separator" as const },
							{
								label: "Check for Updates…",
								click: () => void checkForUpdatesNow("menu"),
							},
							{ type: "separator" as const },
							{
								label: "Preferences…",
								accelerator: "Cmd+,",
								click: () => openSettings(),
							},
							{ type: "separator" as const },
							{ role: "services" as const },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{ role: "quit" as const },
						],
					},
				]
			: []),
		// File menu
		{
			label: "File",
			// CmdOrCtrl+W belongs to the renderer (close tab) - rebind window
			// close so the menu accelerator doesn't swallow the keydown.
			submenu: isMac
				? [{ role: "close" as const, accelerator: "Shift+CmdOrCtrl+W" }]
				: [
						{
							label: "Settings",
							accelerator: "Ctrl+,",
							click: () => openSettings(),
						},
						{ type: "separator" as const },
						{ role: "quit" as const },
					],
		},
		// Edit menu
		{
			label: "Edit",
			submenu: [
				{ role: "undo" as const },
				{ role: "redo" as const },
				{ type: "separator" as const },
				{ role: "cut" as const },
				{ role: "copy" as const },
				{ role: "paste" as const },
				...(isMac
					? [
							{ role: "pasteAndMatchStyle" as const },
							{ role: "delete" as const },
							{ role: "selectAll" as const },
						]
					: [
							{ role: "delete" as const },
							{ type: "separator" as const },
							{ role: "selectAll" as const },
						]),
			],
		},
		// View menu
		{
			label: "View",
			submenu: [
				// Reload / force-reload / DevTools are developer affordances -
				// only surfaced in development builds, not in shipped releases.
				...(isDev
					? [
							{ role: "reload" as const },
							{ role: "forceReload" as const },
							{ role: "toggleDevTools" as const },
							{ type: "separator" as const },
						]
					: []),
				{
					label: "Actual Size",
					accelerator: "CmdOrCtrl+0",
					click: () => sendZoomCommand("reset"),
				},
				{
					label: "Zoom In",
					accelerator: "CmdOrCtrl+=",
					click: () => sendZoomCommand("in"),
				},
				// The role this replaced also answered to Cmd/Ctrl+Plus - the
				// shifted key on most layouts. A hidden twin keeps that binding
				// rather than dropping it silently; one menu item can hold only
				// one accelerator.
				{
					label: "Zoom In",
					accelerator: "CmdOrCtrl+Plus",
					visible: false,
					click: () => sendZoomCommand("in"),
				},
				{
					label: "Zoom Out",
					accelerator: "CmdOrCtrl+-",
					click: () => sendZoomCommand("out"),
				},
				{ type: "separator" as const },
				{ role: "togglefullscreen" as const },
			],
		},
		// Window menu
		{
			label: "Window",
			submenu: [
				{ role: "minimize" as const },
				{ role: "zoom" as const },
				...(isMac
					? [
							{ type: "separator" as const },
							{ role: "front" as const },
							{ type: "separator" as const },
							{ role: "window" as const },
						]
					: [{ role: "close" as const, accelerator: "Shift+CmdOrCtrl+W" }]),
			],
		},
		// Help menu - documentation links on all platforms, plus
		// "Check for Updates…" on Windows/Linux (macOS keeps that in the app
		// menu above).
		{
			label: "Help",
			role: "help" as const,
			submenu: [
				{
					label: "Documentation",
					click: () => shell.openExternal(DOCS_URL),
				},
				{
					label: "Scripting Guide",
					click: () => shell.openExternal(SCRIPTING_DOCS_URL),
				},
				{
					label: "Report an Issue",
					click: () => shell.openExternal(ISSUES_URL),
				},
				...(isMac
					? []
					: [
							{ type: "separator" as const },
							{
								label: "Check for Updates…",
								click: () => void checkForUpdatesNow("menu"),
							},
							{
								label: "About Vayu",
								click: () => app.showAboutPanel(),
							},
						]),
			],
		},
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

async function startEngine() {
	try {
		engineSidecar = new EngineSidecar();
		await engineSidecar.start();
		console.log("[Main] Engine started successfully at", engineSidecar.getApiUrl());
	} catch (error) {
		// A slow engine is not a failed one, and it is not ours to kill. The
		// process is alive and still working through its startup housekeeping; the
		// window is up, the renderer is showing the disconnected state, and its
		// health poll adopts the engine the moment it answers. Quitting here ended
		// launches that were about to succeed.
		if (error instanceof EngineNotReadyError) {
			console.warn(`[Main] ${error.message}; leaving it to the renderer's health poll.`);
			return;
		}

		console.error("[Main] Failed to start engine:", error);
		// Show error dialog to user
		const { dialog } = await import("electron");
		await dialog.showErrorBox(
			"Failed to Start Engine",
			`The Vayu engine failed to start:\n\n${error}\n\nPlease check the logs for more details.`
		);
		app.quit();
	}
}

/**
 * The MCP barrel - the SDK, the tool registry - loaded at most once, on demand.
 *
 * The promise is cached rather than the module, so concurrent callers (a launch
 * starting the server while Settings asks for the catalog) share one evaluation.
 * A rejection is cached with it: the module is a file inside the asar, so a
 * failure to load it is a broken install rather than something a retry fixes.
 * `startMcp` logs one and continues without MCP; the two IPC handlers let it
 * reject, which reaches Settings as the failed call it is.
 */
type McpModule = typeof import("./mcp/index.js");
let mcpModulePromise: Promise<McpModule> | null = null;

function loadMcp(): Promise<McpModule> {
	mcpModulePromise ??= import("./mcp/index.js");
	return mcpModulePromise;
}

async function startMcp() {
	try {
		// Inside the try, not ahead of it: this is the first thing in the whole app
		// to touch the persisted MCP config, so it is where a store failure lands.
		// It also gates the import below, so a disabled launch never evaluates the
		// SDK or the tool registry at all.
		if (!loadMcpEnabled()) {
			console.log("[Main] MCP server disabled by preference; not starting.");
			return;
		}
		const { VayuMcpService } = await loadMcp();
		mcpService = new VayuMcpService({
			engineBaseUrl: `http://${ENGINE_HOST}:${ENGINE_PORT}`,
			host: MCP_HOST,
			port: MCP_PORT,
			version: app.getVersion(),
			safety: loadPersistedSafety(),
			onDataChanged: sendMcpDataChanged,
		});
		await mcpService.start();
		console.log("[Main] MCP server listening at", mcpService.getUrl());
	} catch (error) {
		// The MCP server is a non-critical convenience - a bind failure (e.g. port
		// in use) must not take down the app. Log and continue.
		console.error("[Main] Failed to start MCP server (continuing without it):", error);
		mcpService = null;
	}
}

/**
 * Forward an MCP data change to the renderer so its query cache can invalidate.
 *
 * One-way, main-to-renderer, and it carries no data - only which family went
 * stale (the #278 hardening posture: nothing here takes renderer input, and a
 * push of engine data would be a second source of truth beside the queries).
 *
 * The window is read at send time, not captured: the MCP server starts before
 * the window exists and outlives a renderer reload, so a captured reference
 * would either be null forever or point at destroyed `webContents`.
 */
function sendMcpDataChanged(event: McpDataChangedEvent): void {
	const contents = mainWindow?.webContents;
	if (!contents || contents.isDestroyed()) return;
	contents.send("mcp:data-changed", event);
}

async function stopMcp() {
	if (mcpService) {
		try {
			await mcpService.stop();
			console.log("[Main] MCP server stopped");
		} catch (error) {
			console.error("[Main] Error stopping MCP server:", error);
		}
		mcpService = null;
	}
}

async function stopEngine() {
	if (engineSidecar) {
		try {
			// `shutdown()`, not `stop()`: the app is going away, so a restart in
			// flight has to be waited out and no further one allowed - otherwise
			// the engine it spawns outlives the process that would kill it.
			await engineSidecar.shutdown();
			console.log("[Main] Engine stopped successfully");
		} catch (error) {
			console.error("[Main] Error stopping engine:", error);
		}
	}
}

async function restartEngine(): Promise<{ success: boolean; error?: string }> {
	if (!engineSidecar) {
		return { success: false, error: "Engine sidecar not initialized" };
	}

	try {
		await engineSidecar.restart();
		console.log("[Main] Engine restarted successfully");
		return { success: true };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error("[Main] Failed to restart engine:", errorMessage);
		return { success: false, error: errorMessage };
	}
}

// IPC Handlers
function setupIpcHandlers() {
	// OAuth 2.0 interactive flow (system browser / embedded window)
	setupOAuthIpcHandlers();

	// Open one of the app's own documentation links in the system browser.
	// Keyed rather than URL-taking on purpose: the renderer cannot ask for an
	// arbitrary URL, so this does not hand the web layer a general "open
	// anything" capability. Same links as the Help menu.
	ipcMain.handle("shell:openAppLink", async (_e, key: string) => {
		const links: Record<string, string> = {
			docs: DOCS_URL,
			scripting: SCRIPTING_DOCS_URL,
			issues: ISSUES_URL,
		};
		const url = links[key];
		if (!url) throw new Error(`Unknown app link: ${key}`);
		await shell.openExternal(url);
	});

	// Handle engine restart request from renderer
	ipcMain.handle("engine:restart", async () => {
		return await restartEngine();
	});

	// MCP server status - used by Settings to show the connect URL and state.
	ipcMain.handle("mcp:status", () => {
		return {
			running: mcpService?.isRunning() ?? false,
			url: mcpService?.getUrl() ?? MCP_ENDPOINT_URL,
			enabled: loadMcpEnabled(),
		};
	});

	// One-click connect: register the Vayu endpoint with a client via its own CLI
	// (`claude mcp add`, `code --add-mcp`). Returns cli-not-found so the renderer
	// can fall back to the copy snippet.
	ipcMain.handle("mcp:connectClient", async (_event, client: unknown) => {
		if (client !== "claude" && client !== "vscode") {
			return { ok: false, reason: "unsupported", message: "Unsupported client" };
		}
		const url = mcpService?.getUrl() ?? MCP_ENDPOINT_URL;
		return connectClient(client as McpConnectClient, url);
	});

	// Toggle the MCP server on/off from Settings. Persists the preference and
	// starts/stops the server live. Returns the resulting status.
	ipcMain.handle("mcp:setEnabled", async (_event, enabled: unknown) => {
		const on = enabled === true;
		saveMcpEnabled(on);
		if (on && !mcpService) {
			await startMcp();
		} else if (!on && mcpService) {
			await stopMcp();
		}
		return {
			running: mcpService?.isRunning() ?? false,
			url: mcpService?.getUrl() ?? MCP_ENDPOINT_URL,
			enabled: on,
		};
	});

	// Current MCP safety config (allowlist / caps / writes) for the Settings panel.
	// Falls back to the persisted config, never the defaults - see effectiveSafety.
	ipcMain.handle("mcp:getSafety", (): McpSafetyConfig => {
		return effectiveSafety(mcpService);
	});

	// The tool catalog (name/description/category) for the Settings tool list.
	// Async because the registry is loaded on demand - opening Settings is the
	// place to pay for it, not launching the app.
	ipcMain.handle("mcp:getTools", async () => (await loadMcp()).toolCatalog());

	// Apply and persist a safety-config change from Settings. The renderer input
	// is sanitized here (never trusted), applied live to the running server, and
	// written to disk so it survives a restart. Returns the resolved config.
	ipcMain.handle(
		"mcp:updateSafety",
		async (_event, partial: unknown): Promise<McpSafetyConfig> => {
			const clean = sanitizeSafetyInput((partial ?? {}) as Partial<McpSafetyConfig>);
			// Drop unknown tool names so a stale/hand-edited disabled list can't
			// accumulate junk (the sanitizer can't see the registry). The registry is
			// loaded only on this branch: a caps- or allowlist-only change never needs it.
			if (clean.disabledTools) {
				const known = new Set((await loadMcp()).toolCatalog().map((t) => t.name));
				clean.disabledTools = clean.disabledTools.filter((name) => known.has(name));
			}
			if (mcpService) {
				mcpService.updateSafety(clean);
				const resolved = mcpService.getSafety();
				savePersistedSafety(resolved);
				return resolved;
			}
			// MCP server never came up (e.g. port in use) - still persist so the
			// change takes effect on the next launch.
			const resolved = resolveSafetyConfig({ ...loadPersistedSafety(), ...clean });
			savePersistedSafety(resolved);
			return resolved;
		}
	);

	// Theme management
	ipcMain.handle("theme:get", () => {
		return {
			shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
			themeSource: nativeTheme.themeSource,
		};
	});

	ipcMain.handle("theme:set", (_event, source: "system" | "light" | "dark") => {
		nativeTheme.themeSource = source;
		return {
			shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
			themeSource: nativeTheme.themeSource,
		};
	});

	// Window controls for custom titlebar
	ipcMain.on("window:minimize", () => {
		mainWindow?.minimize();
	});

	ipcMain.on("window:maximize", () => {
		if (mainWindow?.isMaximized()) {
			mainWindow.unmaximize();
		} else {
			mainWindow?.maximize();
		}
	});

	ipcMain.on("window:close", () => {
		mainWindow?.close();
	});

	ipcMain.handle("window:isMaximized", () => {
		return mainWindow?.isMaximized() ?? false;
	});

	/**
	 * The Windows system menu, popped from the title-bar app icon.
	 *
	 * Windows convention is that the icon *is* the system-menu control: left
	 * click opens it, right click opens it, Alt+Space opens it. Vayu got the
	 * right-click half for free, because a `-webkit-app-region: drag` area is
	 * treated as a non-client frame and Windows pops the real menu on it. Left
	 * click was missing, and it cannot be added to a drag region at all -
	 * draggable areas ignore every pointer event.
	 *
	 * So the icon is marked `no-drag` on Windows and both buttons are handled
	 * here. That trades the OS's own menu for this one, which is why the
	 * right-click path had to be reimplemented in the same change rather than
	 * left to the platform.
	 *
	 * The native alternative would be returning HTSYSMENU from WM_NCHITTEST for
	 * the icon's rect, which is how Win32 does it and would have kept the real
	 * menu. Electron does not handle WM_NCHITTEST in PreHandleMSG, and
	 * hookWindowMessage callbacks cannot return a value to the OS
	 * (electron/electron#8762), so it is unreachable without a native module.
	 *
	 * Move and Size are deliberately absent: both are Win32 modal drag loops
	 * with no Electron equivalent, and a disabled item that never becomes
	 * enabled is worse than one that was never offered.
	 */
	ipcMain.on("window:systemMenu", (_event, position?: { x: number; y: number }) => {
		if (!mainWindow || process.platform !== "win32") return;
		const maximized = mainWindow.isMaximized();
		const menu = Menu.buildFromTemplate([
			{
				label: "Restore",
				enabled: maximized,
				click: () => mainWindow?.unmaximize(),
			},
			{
				label: "Minimize",
				click: () => mainWindow?.minimize(),
			},
			{
				label: "Maximize",
				enabled: !maximized,
				click: () => mainWindow?.maximize(),
			},
			{ type: "separator" },
			{
				label: "Close",
				accelerator: "Alt+F4",
				click: () => mainWindow?.close(),
			},
		]);
		// Rounded because Electron rejects fractional coordinates, and the
		// renderer's getBoundingClientRect returns them on a scaled display.
		menu.popup({
			window: mainWindow,
			...(position ? { x: Math.round(position.x), y: Math.round(position.y) } : {}),
		});
	});

	// Listen for maximize/unmaximize to notify renderer
	app.on("browser-window-created", (_event, window) => {
		window.on("maximize", () => {
			window.webContents.send("window:maximized", true);
		});
		window.on("unmaximize", () => {
			window.webContents.send("window:maximized", false);
		});
	});

	// Get app paths (app dir, logs path, db path). Derived in app-paths.ts so
	// this handler cannot drift from the sidecar's own data directory.
	ipcMain.handle("app:getPaths", () => resolveAppPaths());

	// Re-open a collection's declared data file (issue #599). The one channel on
	// which the renderer names a path of its own, gated by an extension
	// allowlist and the engine's fetched byte cap - the rationale, and the
	// alternative that was rejected, are in data-file.ts.
	ipcMain.handle("dataFile:read", async (_event, filePath: unknown) => {
		return await readDataFile(String(filePath ?? ""));
	});

	// Read a file an imported OpenAPI document references (issue #649). The
	// renderer passes the picked document's path and the ref's own text; this
	// process resolves one against the other, so the web layer still names no
	// directory of its own. Gates and the rejected alternative are in spec-file.ts.
	ipcMain.handle("specFile:read", async (_event, specPath: unknown, refPath: unknown) => {
		return await readSpecFile(String(specPath ?? ""), String(refPath ?? ""));
	});

	// Re-resolve the operating system's proxy and push it to the engine (#708).
	// The renderer is the second of the two things that can know the network
	// changed - it holds the `online` event and the settings screen where a
	// user switches to `system` in the first place - and `refreshSystemProxy`
	// writes nothing when the answer has not moved, so calling it eagerly is
	// free. It resolves; it does not read the OS on the renderer's behalf for
	// any other purpose, so there is no path to name here.
	ipcMain.handle("proxy:refreshSystem", async () => {
		return await refreshSystemProxy(proxyResolution());
	});
}

/**
 * The proxy resolver bound to this process's Chromium session.
 *
 * Built per call rather than once, because `session.defaultSession` does not
 * exist until the app is ready and this module is imported long before that.
 */
function proxyResolution(): ProxyResolutionSystem {
	return {
		...defaultProxyResolutionSystem,
		resolveProxy: (url: string) => session.defaultSession.resolveProxy(url),
	};
}

/**
 * Vayu is a single-instance app, and the engine is why.
 *
 * The engine binds one fixed port and owns one SQLite database, so a second
 * launch does not get a second backend - it adopts the first one's. Both UIs
 * then share one engine with nothing to say so, and the first to quit POSTs
 * `/shutdown`, which the engine obeys unconditionally: the survivor's backend
 * dies under it mid-session, its pending saves go into a dead port, and its
 * only surface is the dock dot turning grey.
 *
 * Losing the lock means another instance is already up, so hand the user over
 * to it and leave. `second-instance` fires in the instance that holds the lock.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();

if (!isPrimaryInstance) {
	console.log("[Main] Another Vayu instance is already running; focusing it and exiting.");
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
}

app.whenReady().then(async () => {
	// A losing second instance is on its way out; do not start an engine, a
	// server or a window on top of the instance that owns them.
	if (!isPrimaryInstance) return;

	// Setup IPC handlers first
	setupIpcHandlers();

	// Tell install.sh which version is actually installed. On Linux the
	// AppImage updates itself, and the version file the installer wrote does
	// not move with it - so the next `install.sh` run would re-download a
	// release already on disk. No-op on every other platform and for an
	// AppImage running from anywhere but the managed path. Fire and forget:
	// the file is advisory and startup must not wait on it.
	void stampInstalledVersion(
		{
			platform: process.platform,
			appImagePath: process.env.APPIMAGE,
			xdgDataHome: process.env.XDG_DATA_HOME,
			home: app.getPath("home"),
		},
		app.getVersion()
	);

	// Populate the native About panel (used by Help → About Vayu on
	// Windows/Linux, and the macOS app menu's About item).
	// iconPath is bundled as a loose resource (extraResources) so it resolves
	// at runtime; in dev it lives in the repo's shared assets.
	const aboutIconPath = isDev
		? path.join(app.getAppPath(), "..", "shared", "icon_png", "vayu_icon_256x256.png")
		: path.join(process.resourcesPath, "icon.png");
	app.setAboutPanelOptions({
		applicationName: "Vayu",
		applicationVersion: app.getVersion(),
		copyright: "© 2026 Atharva Kusumbia",
		website: "https://github.com/athrvk/vayu",
		iconPath: aboutIconPath,
	});

	// Create application menu
	createMenu();

	// One registration for the process, ahead of any window - see the function.
	installThemeBridge();

	// The window first, and the engine alongside it. The renderer does not need
	// the engine to boot - its health query polls `/health` over HTTP and simply
	// retries, and the Dock renders the disconnected state until it answers - so
	// nothing was gained by making the user watch an empty screen for the length
	// of the handshake. What was lost was everything: `db.init()` runs orphan
	// reconciliation, inbox cleanup and a page-reclaim rewrite before the engine
	// listens at all, and that whole window was blank screen.
	//
	// Nothing may sit between here and the engine that can fail on its own: the
	// MCP server used to, and because it reads a config file at that point, a
	// corrupt one left the app with a headless engine and no window. MCP is an
	// optional convenience with no UI depending on it, so it still starts after
	// everything the user can see is up and wired.
	createWindow();

	// Awaited, not fired and forgotten: the proxy bridge below talks to the
	// engine, and the updater and MCP both read state the engine owns. The window
	// is already loading throughout, which was the point.
	await startEngine();

	// Bridge the OS proxy into the engine (#708). Fire and forget: it never
	// throws and never blocks on the network - the resolution is local to
	// Chromium - so the window has its proxy row a moment later, and the settings
	// screen refreshes it on arrival anyway. A slow engine is why this is not
	// awaited: `startEngine` above returns without one, and the settings refresh
	// is the backstop for the row this call then fails to fill.
	void refreshSystemProxy(proxyResolution());

	// Waking on a different network is the common way a laptop's proxy changes
	// under a running app: home to office, office to VPN. Electron surfaces no
	// network-change event in the main process, so this is the half that can be
	// caught here; the renderer's `online` listener catches the other half and
	// calls the `proxy:refreshSystem` channel.
	powerMonitor.on("resume", () => {
		void refreshSystemProxy(proxyResolution());
	});

	// Start checking for updates once a window exists to receive events. The
	// updater reads `mainWindow` at send time rather than being handed the window
	// now: on macOS the app outlives its window, and a dock-activate builds a
	// replacement that a captured reference would never reach.
	initAutoUpdater(() => mainWindow);

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	// Start the MCP server last (best-effort; it never blocks app startup). It
	// swallows its own failures, and starting it here means even one that escaped
	// that guard would cost the user nothing but MCP.
	await startMcp();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// One stable callback, not a fresh closure per quit: every quit gesture that
// lands during the flush resumes the same quit, so a double Cmd-Q takes the
// second pass once rather than starting two engine shutdowns.
const resumeQuit = () => app.quit();

// Second pass of the quit: stop the children exactly once. See quit-shutdown.ts
// for why "has a shutdown started" is the guard rather than "is the engine
// still running" - the latter only clears after the awaits, so a quit landing
// mid-shutdown started a second one on top of it.
const quitShutdown = createQuitShutdown({
	hasWork: () => Boolean((engineSidecar && engineSidecar.isRunning()) || mcpService),
	stop: async () => {
		await stopMcp();
		await stopEngine();
	},
	quit: () => app.quit(),
	defer: (run) => {
		setImmediate(run);
	},
});

// Ensure saves are flushed and engine is stopped when the app quits
app.on("before-quit", (event) => {
	// First pass: ask the renderer to flush pending saves. Quit resumes as
	// soon as the renderer ACKs, with a 2s ceiling in case it is stuck. Only a
	// flush that has *settled* falls through to the second pass - a second quit
	// gesture arriving mid-flush joins the flush in flight instead, so the
	// engine is never stopped out from under saves still being written.
	if (!saveFlusher.hasSettled()) {
		event.preventDefault();
		saveFlusher.flush(resumeQuit);
		return;
	}

	quitShutdown.handleQuit(event);
});

// The quit is settled by now, so stop the periodic update check and answer a
// check the user is still waiting on - its events will never arrive.
app.on("will-quit", () => {
	disposeAutoUpdater();
});

// A signal is how anything outside the UI asks Vayu to stop, and Node's default
// is to terminate the process where it stands - skipping the handler above
// entirely, so pending saves are lost and the engine and MCP children are
// orphaned. This routes them into the same shutdown Cmd-Q takes. It matters
// most on Linux, where install.sh has no Apple Event to quit the app with
// before it replaces the AppImage, only a signal.
installQuitOnSignal(process, () => app.quit());
