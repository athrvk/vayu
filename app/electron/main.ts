import { app, BrowserWindow, ipcMain, nativeTheme, Menu } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { EngineSidecar } from "./sidecar.js";
import { loadWindowState, trackWindowState } from "./window-state.js";

const isDev = process.env.NODE_ENV === "development";

// __dirname is not defined in ES modules. Derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global sidecar instance
let engineSidecar: EngineSidecar | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow() {
	// Load persisted window state
	const windowState = loadWindowState({
		defaultWidth: 1400,
		defaultHeight: 900,
	});

	mainWindow = new BrowserWindow({
		width: windowState.width,
		height: windowState.height,
		x: windowState.x,
		y: windowState.y,
		minWidth: 1024,
		minHeight: 768,
		// Custom titlebar settings
		frame: false,
		titleBarStyle: "hidden",
		titleBarOverlay:
			process.platform === "darwin"
				? {
						color: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#ffffff",
						symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1a1a",
						height: 40,
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
		mainWindow.loadURL("http://localhost:5173");
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

		// Update titlebar overlay color on macOS
		if (process.platform === "darwin" && mainWindow) {
			mainWindow.setTitleBarOverlay({
				color: nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#ffffff",
				symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1a1a1a",
			});
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
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
			submenu: [isMac ? { role: "close" as const } : { role: "quit" as const }],
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
				{ role: "reload" as const },
				{ role: "forceReload" as const },
				{ role: "toggleDevTools" as const },
				{ type: "separator" as const },
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
					: [{ role: "close" as const }]),
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
}

app.whenReady().then(async () => {
	// Setup IPC handlers first
	setupIpcHandlers();

	// Create application menu
	createMenu();

	// Start the engine
	await startEngine();

	// Then create the window
	createWindow();

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

// Ensure engine is stopped when the app quits
app.on("before-quit", async (event) => {
	if (engineSidecar && engineSidecar.isRunning()) {
		event.preventDefault();
		await stopEngine();
		// Continue with quit process
		setImmediate(() => app.quit());
	}
});
