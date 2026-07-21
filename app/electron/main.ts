/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, Menu, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { EngineSidecar } from "./sidecar.js";
import { setupOAuthIpcHandlers } from "./oauth.js";
import { loadWindowState, trackWindowState } from "./window-state.js";
import { initAutoUpdater, checkForUpdatesNow } from "./updater.js";
import {
	VayuMcpService,
	DEFAULT_MCP_SAFETY_CONFIG,
	resolveSafetyConfig,
	sanitizeSafetyInput,
	loadPersistedSafety,
	savePersistedSafety,
	loadMcpEnabled,
	saveMcpEnabled,
	connectClient,
	toolCatalog,
	type McpConnectClient,
	type McpSafetyConfig,
} from "./mcp/index.js";
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

// Track if we've already sent the before-quit flush message
let flushSent = false;

function createWindow() {
	// Reset flush flag when creating a new window
	flushSent = false;

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
		// Center the macOS traffic lights inside the titlebar (lights are ~16px)
		trafficLightPosition:
			process.platform === "darwin"
				? { x: 12, y: Math.round((TITLEBAR_HEIGHT - 16) / 2) }
				: undefined,
		// Windows-only native overlay — Linux uses custom HTML buttons
		titleBarOverlay:
			process.platform === "win32"
				? {
						color: nativeTheme.shouldUseDarkColors ? "#111113" : "#f2f0eb",
						symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f0eb" : "#111113",
						height: TITLEBAR_HEIGHT,
					}
				: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js"),
		},
		title: "Vayu",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
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

	if (isDev) {
		mainWindow.loadURL(DEV_SERVER_URL);
		// mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
	}

	mainWindow.on("page-title-updated", (event) => {
		event.preventDefault();
	});

	// Send theme to renderer when it changes
	nativeTheme.on("updated", () => {
		mainWindow?.webContents.send("theme:changed", {
			shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
			themeSource: nativeTheme.themeSource,
		});

		// Update titlebar overlay color — Windows only
		if (process.platform === "win32" && mainWindow) {
			mainWindow.setTitleBarOverlay({
				color: nativeTheme.shouldUseDarkColors ? "#111113" : "#f2f0eb",
				symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f0eb" : "#111113",
				height: TITLEBAR_HEIGHT,
			});
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

/** Ask the renderer to open the Settings view (from the menu / ⌘,). */
function openSettings() {
	mainWindow?.webContents.send("menu:open-settings");
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
			// CmdOrCtrl+W belongs to the renderer (close tab) — rebind window
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
				// Reload / force-reload / DevTools are developer affordances —
				// only surfaced in development builds, not in shipped releases.
				...(isDev
					? [
							{ role: "reload" as const },
							{ role: "forceReload" as const },
							{ role: "toggleDevTools" as const },
							{ type: "separator" as const },
						]
					: []),
				{ role: "resetZoom" as const },
				{ role: "zoomIn" as const },
				{ role: "zoomOut" as const },
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
		// Help menu — documentation links on all platforms, plus
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
		engineSidecar = new EngineSidecar(9876);
		await engineSidecar.start();
		console.log("[Main] Engine started successfully at", engineSidecar.getApiUrl());
	} catch (error) {
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

async function startMcp() {
	if (!loadMcpEnabled()) {
		console.log("[Main] MCP server disabled by preference; not starting.");
		return;
	}
	try {
		mcpService = new VayuMcpService({
			engineBaseUrl: `http://${ENGINE_HOST}:${ENGINE_PORT}`,
			host: MCP_HOST,
			port: MCP_PORT,
			version: app.getVersion(),
			safety: loadPersistedSafety(),
		});
		await mcpService.start();
		console.log("[Main] MCP server listening at", mcpService.getUrl());
	} catch (error) {
		// The MCP server is a non-critical convenience — a bind failure (e.g. port
		// in use) must not take down the app. Log and continue.
		console.error("[Main] Failed to start MCP server (continuing without it):", error);
		mcpService = null;
	}
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
			await engineSidecar.stop();
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

	// Handle engine status check
	ipcMain.handle("engine:status", () => {
		return {
			running: engineSidecar?.isRunning() ?? false,
			url: engineSidecar?.getApiUrl() ?? null,
		};
	});

	// MCP server status — used by Settings to show the connect URL and state.
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
	ipcMain.handle("mcp:getSafety", (): McpSafetyConfig => {
		return mcpService?.getSafety() ?? DEFAULT_MCP_SAFETY_CONFIG;
	});

	// The tool catalog (name/description/category) for the Settings tool list.
	ipcMain.handle("mcp:getTools", () => toolCatalog());

	// Apply and persist a safety-config change from Settings. The renderer input
	// is sanitized here (never trusted), applied live to the running server, and
	// written to disk so it survives a restart. Returns the resolved config.
	ipcMain.handle("mcp:updateSafety", (_event, partial: unknown): McpSafetyConfig => {
		const clean = sanitizeSafetyInput((partial ?? {}) as Partial<McpSafetyConfig>);
		// Drop unknown tool names so a stale/hand-edited disabled list can't
		// accumulate junk (the sanitizer can't see the registry).
		if (clean.disabledTools) {
			const known = new Set(toolCatalog().map((t) => t.name));
			clean.disabledTools = clean.disabledTools.filter((name) => known.has(name));
		}
		if (mcpService) {
			mcpService.updateSafety(clean);
			const resolved = mcpService.getSafety();
			savePersistedSafety(resolved);
			return resolved;
		}
		// MCP server never came up (e.g. port in use) — still persist so the
		// change takes effect on the next launch.
		const resolved = resolveSafetyConfig({ ...loadPersistedSafety(), ...clean });
		savePersistedSafety(resolved);
		return resolved;
	});

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

	// Listen for maximize/unmaximize to notify renderer
	app.on("browser-window-created", (_event, window) => {
		window.on("maximize", () => {
			window.webContents.send("window:maximized", true);
		});
		window.on("unmaximize", () => {
			window.webContents.send("window:maximized", false);
		});
	});

	// Get app paths (app dir, logs path, db path)
	ipcMain.handle("app:getPaths", () => {
		const appDir = app.getAppPath();

		// Get data directory using the same logic as EngineSidecar
		const isDev = process.env.NODE_ENV === "development";
		let dataDir: string;
		if (isDev) {
			dataDir = path.join(appDir, "..", "engine", "data");
		} else {
			dataDir = app.getPath("userData");
		}

		const logsPath = path.join(dataDir, "logs");
		const dbPath = path.join(dataDir, "db");

		return {
			appDir,
			dataDir,
			logsPath,
			dbPath,
		};
	});
}

app.whenReady().then(async () => {
	// Setup IPC handlers first
	setupIpcHandlers();

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

	// Start the engine
	await startEngine();

	// Start the MCP server (best-effort; never blocks app startup)
	await startMcp();

	// Then create the window
	createWindow();

	// Start checking for updates once the window exists to receive events
	if (mainWindow) {
		initAutoUpdater(mainWindow);
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Ensure saves are flushed and engine is stopped when the app quits
app.on("before-quit", (event) => {
	// First pass: ask the renderer to flush pending saves. Quit resumes as
	// soon as the renderer ACKs, with a 2s ceiling in case it is stuck.
	if (!flushSent) {
		flushSent = true;
		event.preventDefault();
		let resumed = false;
		const resumeQuit = () => {
			if (resumed) return;
			resumed = true;
			ipcMain.removeListener("before-quit-flushed", resumeQuit);
			app.quit();
		};
		if (!mainWindow) {
			resumeQuit();
			return;
		}
		ipcMain.once("before-quit-flushed", resumeQuit);
		setTimeout(resumeQuit, 2000);
		mainWindow.webContents.send("before-quit");
		return;
	}

	// Second pass: stop the MCP server and engine before actually quitting
	if ((engineSidecar && engineSidecar.isRunning()) || mcpService) {
		event.preventDefault();
		(async () => {
			await stopMcp();
			await stopEngine();
			// Continue with quit process
			setImmediate(() => app.quit());
		})();
	}
});
