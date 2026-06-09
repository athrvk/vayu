/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { BrowserWindow } from "electron";
import { app, dialog, ipcMain, shell } from "electron";
// electron-updater is CommonJS; under "type": "module" the named export must
// be pulled off the default import.
import electronUpdater from "electron-updater";
import { resolveUpdateStrategy, type UpdateStrategy } from "./updater-strategy.js";

const { autoUpdater } = electronUpdater;

const REPO = "athrvk/vayu";
/** Re-check for updates every 6 hours while the app stays open. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function releaseUrl(version: string): string {
	return `https://github.com/${REPO}/releases/tag/v${version}`;
}

/** One-liner that re-runs the ad-hoc-signing installer on macOS. */
function macInstallCommand(): string {
	return `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/${REPO}/master/install.sh)"`;
}

export interface UpdateAvailablePayload {
	version: string;
	strategy: UpdateStrategy;
	releaseUrl: string;
	/** Present only on the macOS notify path. */
	installCommand?: string;
}

let intervalTimer: NodeJS.Timeout | null = null;
/** True once initAutoUpdater has configured the updater (not in dev). */
let updaterReady = false;
/** Set while a user-initiated check is in flight, so we can show feedback. */
let manualCheckPending = false;
let mainWindowRef: BrowserWindow | null = null;

/**
 * Wire up auto-update for the current platform.
 *
 *   - silent (Windows, Linux AppImage): download in the background, then tell
 *     the renderer it can restart-and-install.
 *   - notify (macOS, Linux .deb): only check the version feed and surface the
 *     newer release in the UI; the user updates out-of-band.
 *   - disabled (development): no-op.
 */
export function initAutoUpdater(win: BrowserWindow): void {
	const isDev = process.env.NODE_ENV === "development";
	const isAppImage = Boolean(process.env.APPIMAGE);
	const strategy = resolveUpdateStrategy({
		platform: process.platform,
		isDev,
		isAppImage,
	});

	mainWindowRef = win;

	if (strategy === "disabled") {
		console.log("[Updater] disabled (development)");
		return;
	}

	autoUpdater.autoDownload = strategy === "silent";
	autoUpdater.autoInstallOnAppQuit = strategy === "silent";
	autoUpdater.allowPrerelease = false;

	const send = (channel: string, payload: unknown) => {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	};

	autoUpdater.on("update-available", (info) => {
		const payload: UpdateAvailablePayload = {
			version: info.version,
			strategy,
			releaseUrl: releaseUrl(info.version),
			installCommand:
				strategy === "notify" && process.platform === "darwin"
					? macInstallCommand()
					: undefined,
		};
		send("update:available", payload);
	});

	autoUpdater.on("update-downloaded", (info) => {
		send("update:downloaded", { version: info.version });
	});

	// Only surfaced for user-initiated checks; the periodic check stays silent.
	autoUpdater.on("update-not-available", () => {
		if (manualCheckPending) {
			manualCheckPending = false;
			void dialog.showMessageBox(win, {
				type: "info",
				message: "You're up to date",
				detail: `Vayu ${app.getVersion()} is the latest version.`,
				buttons: ["OK"],
			});
		}
	});

	autoUpdater.on("error", (err) => {
		console.error("[Updater] error:", err);
		if (manualCheckPending) {
			manualCheckPending = false;
			void dialog.showMessageBox(win, {
				type: "error",
				message: "Couldn't check for updates",
				detail: err.message,
				buttons: ["OK"],
			});
		}
	});

	updaterReady = true;

	// Renderer-driven actions.
	ipcMain.handle("update:restartToInstall", () => {
		// Only meaningful on the silent path, where an update was downloaded.
		autoUpdater.quitAndInstall();
	});

	ipcMain.handle("update:openReleasePage", (_event, url: string) => {
		return shell.openExternal(url);
	});

	const check = () =>
		autoUpdater.checkForUpdates().catch((err) => console.error("[Updater] check failed:", err));

	void check();
	intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
}

/**
 * Trigger a check on demand (from the "Check for Updates…" menu item).
 * Shows a dialog when already up to date or when the check fails, so the user
 * always gets feedback — unlike the silent periodic check.
 */
export function checkForUpdatesNow(): void {
	if (!updaterReady) {
		if (mainWindowRef) {
			void dialog.showMessageBox(mainWindowRef, {
				type: "info",
				message: "Updates unavailable",
				detail: "Update checks only run in packaged builds of Vayu.",
				buttons: ["OK"],
			});
		}
		return;
	}
	manualCheckPending = true;
	autoUpdater.checkForUpdates().catch((err) => {
		console.error("[Updater] manual check failed:", err);
	});
}

/** Stop the periodic check (used on app teardown / tests). */
export function disposeAutoUpdater(): void {
	if (intervalTimer) {
		clearInterval(intervalTimer);
		intervalTimer = null;
	}
}
