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
import { REPO, UPDATE_CHECK_INTERVAL_MS as CHECK_INTERVAL_MS } from "./constants.js";

const { autoUpdater } = electronUpdater;

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

/**
 * Outcome of a user-initiated check.
 *
 * The periodic check stays silent, so it produces no result - only a check the
 * user asked for needs an answer, and "nothing happened" is not one.
 */
export type UpdateCheckResult =
	| { status: "unavailable"; detail: string }
	| { status: "up-to-date"; version: string }
	| ({ status: "available" } & UpdateAvailablePayload)
	| { status: "error"; message: string };

/** Where a manual check came from - it decides how the result is delivered. */
type CheckSource = "menu" | "renderer";

/**
 * A check the user asked for and is waiting on. electron-updater answers
 * through events rather than the `checkForUpdates()` promise, so the settle
 * path runs from the event handlers.
 */
interface PendingCheck {
	source: CheckSource;
	settle: (result: UpdateCheckResult) => void;
	promise: Promise<UpdateCheckResult>;
	timer: NodeJS.Timeout;
}

/**
 * How long to wait for an answer before giving up. Without this a check that
 * never gets a reply - a hung connection, a feed that stalls after the TCP
 * handshake - leaves the settings button spinning with no way back.
 */
const CHECK_TIMEOUT_MS = 30_000;

let intervalTimer: NodeJS.Timeout | null = null;
/** True once initAutoUpdater has configured the updater (not in dev). */
let updaterReady = false;
let pendingCheck: PendingCheck | null = null;
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

	// Registered before the `disabled` bail-out. The renderer calls these
	// unconditionally, and an unregistered channel rejects with "No handler
	// registered" - an error that reads like a bug rather than "not in a
	// packaged build". They no-op safely while `updaterReady` is false.
	ipcMain.handle("update:restartToInstall", () => {
		// Only meaningful on the silent path, where an update was downloaded.
		if (updaterReady) autoUpdater.quitAndInstall();
	});

	ipcMain.handle("update:openReleasePage", (_event, url: string) => {
		return shell.openExternal(url);
	});

	ipcMain.handle("update:check", () => checkForUpdatesNow("renderer"));

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
		settleCheck({ status: "available", ...payload });
	});

	autoUpdater.on("update-downloaded", (info) => {
		send("update:downloaded", { version: info.version });
	});

	// Only surfaced for user-initiated checks; the periodic check stays silent.
	autoUpdater.on("update-not-available", () => {
		settleCheck({ status: "up-to-date", version: app.getVersion() });
	});

	autoUpdater.on("error", (err) => {
		console.error("[Updater] error:", err);
		settleCheck({ status: "error", message: err.message });
	});

	updaterReady = true;

	const check = () =>
		autoUpdater.checkForUpdates().catch((err) => console.error("[Updater] check failed:", err));

	void check();
	intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
}

/**
 * Deliver the outcome of the check the user is waiting on, if any.
 *
 * Events fire for the periodic check too, so a result with nothing waiting is
 * dropped - that is the silent path doing its job, not a missed answer.
 */
function settleCheck(result: UpdateCheckResult): void {
	const pending = pendingCheck;
	if (!pending) return;
	pendingCheck = null;
	clearTimeout(pending.timer);

	// The menu item has no UI of its own, so it reports through a native
	// dialog. The settings panel renders the same result in place, and a modal
	// on top of it would be redundant.
	if (pending.source === "menu" && mainWindowRef) {
		if (result.status === "up-to-date") {
			void dialog.showMessageBox(mainWindowRef, {
				type: "info",
				message: "You're up to date",
				detail: `Vayu ${result.version} is the latest version.`,
				buttons: ["OK"],
			});
		} else if (result.status === "error") {
			void dialog.showMessageBox(mainWindowRef, {
				type: "error",
				message: "Couldn't check for updates",
				detail: result.message,
				buttons: ["OK"],
			});
		}
		// "available" needs no dialog - the update banner is already showing it.
	}

	pending.settle(result);
}

/**
 * Trigger a check on demand, from the "Check for Updates…" menu item or from
 * Settings → General. Always resolves with an outcome, so the caller can give
 * the user feedback - unlike the periodic check, which stays silent.
 */
export function checkForUpdatesNow(source: CheckSource = "menu"): Promise<UpdateCheckResult> {
	if (!updaterReady) {
		const result: UpdateCheckResult = {
			status: "unavailable",
			detail: "Update checks only run in packaged builds of Vayu.",
		};
		if (source === "menu" && mainWindowRef) {
			void dialog.showMessageBox(mainWindowRef, {
				type: "info",
				message: "Updates unavailable",
				detail: result.detail,
				buttons: ["OK"],
			});
		}
		return Promise.resolve(result);
	}

	// A check is already in flight: join it rather than starting a second one.
	// Both callers then get the same answer, and only one dialog is shown.
	if (pendingCheck) return pendingCheck.promise;

	let settle!: (result: UpdateCheckResult) => void;
	const promise = new Promise<UpdateCheckResult>((resolve) => {
		settle = resolve;
	});
	const timer = setTimeout(() => {
		settleCheck({ status: "error", message: "The update check timed out." });
	}, CHECK_TIMEOUT_MS);
	// Node keeps the process alive for a pending timer; this one must not hold
	// up quit if the user closes the window mid-check.
	timer.unref?.();
	pendingCheck = { source, settle, promise, timer };

	autoUpdater.checkForUpdates().catch((err) => {
		// The `error` event usually fires too, but not for every rejection -
		// settling here as well is safe because settleCheck is idempotent.
		console.error("[Updater] manual check failed:", err);
		settleCheck({ status: "error", message: err instanceof Error ? err.message : String(err) });
	});

	return promise;
}

/** Stop the periodic check (used on app teardown / tests). */
export function disposeAutoUpdater(): void {
	if (intervalTimer) {
		clearInterval(intervalTimer);
		intervalTimer = null;
	}
	// A check waiting on an event that will never arrive now the app is going
	// away: settle it so nothing is left hanging on the promise.
	settleCheck({ status: "error", message: "The update check was cancelled." });
}
