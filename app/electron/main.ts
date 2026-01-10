import { app, BrowserWindow } from "electron";
import path from "path";

const isDev = process.env.NODE_ENV === "development";

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
		title: "Vayu Desktop",
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

app.whenReady().then(() => {
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
