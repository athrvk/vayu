import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { EngineSidecar } from "./sidecar.js";

const isDev = process.env.NODE_ENV === "development";

// __dirname is not defined in ES modules. Derive it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global sidecar instance
let engineSidecar: EngineSidecar | null = null;

function createWindow() {
	const mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 1024,
		minHeight: 768,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "preload.js"),
		},
		title: "Vayu",
		backgroundColor: "#ffffff",
	});

	if (isDev) {
		mainWindow.loadURL("http://127.0.0.1:5173");
		mainWindow.webContents.openDevTools();
	} else {
		mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
	}

	mainWindow.on("page-title-updated", (event) => {
		event.preventDefault();
	});
}

async function startEngine() {
	try {
		engineSidecar = new EngineSidecar(9876);
		await engineSidecar.start();
		console.log(
			"[Main] Engine started successfully at",
			engineSidecar.getApiUrl(),
		);
	} catch (error) {
		console.error("[Main] Failed to start engine:", error);
		// Show error dialog to user
		const { dialog } = await import("electron");
		await dialog.showErrorBox(
			"Failed to Start Engine",
			`The Vayu engine failed to start:\n\n${error}\n\nPlease check the logs for more details.`,
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

app.whenReady().then(async () => {
	// Start the engine first
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
