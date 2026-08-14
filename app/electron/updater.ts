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

/**
 * One-liner that re-runs the ad-hoc-signing installer on macOS.
 *
 * This *is* the macOS update mechanism - the strategy is "notify" because an
 * ad-hoc signature gives Squirrel.Mac nothing to verify - so it has to stay
 * byte-identical to the command README.md documents, which
 * `updater.test.ts` asserts by reading the README.
 *
 * Not built from `REPO`: the script is served by the docs site (published from
 * the repo root by .github/hooks/install_script.py), which has no owner/repo in
 * its path.
 */
function macInstallCommand(): string {
	return `bash -c "$(curl -fsSL https://athrvk.github.io/vayu/install.sh)"`;
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
 *
 * This is one budget for the whole check, retry included: the user clicked once
 * and the wait they can see must stay bounded by one number. A retry that runs
 * out of budget reports the timeout rather than the first error - the first
 * error is logged either way.
 */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * A check gets one automatic retry, because on a cold network stack the first
 * answer is often not the truth.
 *
 * A mac check is three sequential HTTPS requests through Chromium's net stack,
 * and a transient there (`ERR_NETWORK_CHANGED` while Wi-Fi settles after launch
 * or wake is the textbook one) used to become the final answer. The join rule
 * below amplifies it: a click that lands while the startup check is in flight
 * inherits that check's fate, so the coldest possible attempt answered a click
 * made minutes later. Retrying once absorbs that without giving up the join.
 */
const MAX_CHECK_ATTEMPTS = 2;

/** Long enough for a settling network stack, short enough to still feel like one click. */
const RETRY_DELAY_MS = 2_000;

let intervalTimer: NodeJS.Timeout | null = null;
/** True once initAutoUpdater has configured the updater (not in dev). */
let updaterReady = false;
let pendingCheck: PendingCheck | null = null;
let resolveWindow: WindowAccessor | null = null;

/**
 * Attempts started for the check cycle in flight, 0 when none is.
 *
 * Module state rather than a field on `PendingCheck` because the periodic and
 * startup checks retry too, and nobody is waiting on those.
 */
let attempt = 0;
/** The attempt whose failure has already been acted on - see `handleCheckFailure`. */
let failedAttempt = 0;
let retryTimer: NodeJS.Timeout | null = null;

/**
 * How the updater finds the window to talk to, asked fresh every time.
 *
 * Not a captured `BrowserWindow`: on macOS the app outlives its window, and a
 * dock-activate builds a new one. A reference taken at startup would point at
 * the closed window for the rest of the session, so every periodic update event
 * would hit the `isDestroyed()` guard and be dropped - and on macOS that banner
 * is the whole passive update path.
 */
export type WindowAccessor = () => BrowserWindow | null;

/** The window as it is right now, or null if there isn't a usable one. */
function liveWindow(): BrowserWindow | null {
	const win = resolveWindow?.() ?? null;
	return win && !win.isDestroyed() ? win : null;
}

/**
 * The fullest description of a failed check we can give the user.
 *
 * electron-updater raises coded errors (`newError(message, code)`), and the
 * code is the part worth reporting: "Cannot find latest-mac.yml" and
 * `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` say different things about who is at
 * fault. The message is what the settings panel and the menu dialog print, so
 * the code has to travel inside it - there is no second field for a reader to
 * miss.
 */
function describeError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const parts = [err.message];
	const code: unknown = (err as { code?: unknown }).code;
	if (typeof code === "string" && code && !err.message.includes(code)) {
		parts.push(`(${code})`);
	}
	// Some codes already embed their cause in the message; only add one that is
	// not already there. Read off the object rather than `err.cause`: the
	// electron tsconfig's lib predates it, and a failure description is not a
	// reason to move the whole target.
	const cause: unknown = (err as { cause?: unknown }).cause;
	const causeText =
		cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
	if (causeText && !err.message.includes(causeText)) parts.push(`- ${causeText}`);
	return parts.join(" ");
}

/** Drop a scheduled retry - the cycle ended, or a newer one replaced it. */
function clearRetry(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

/** Ask electron-updater for the feed. Failures land in `handleCheckFailure`. */
function runCheckAttempt(): void {
	autoUpdater.checkForUpdates().catch((err: unknown) => {
		// The `error` event fires for the same failure, so this and the handler
		// both report it; `handleCheckFailure` acts on an attempt once.
		handleCheckFailure(err);
	});
}

/** Start a check with a full retry budget. Every check path goes through here. */
function startCheckCycle(): void {
	clearRetry();
	attempt = 1;
	failedAttempt = 0;
	runCheckAttempt();
}

/** The cycle is over: an answer arrived, the budget is spent, or we are quitting. */
function endCheckCycle(): void {
	clearRetry();
	attempt = 0;
	failedAttempt = 0;
}

/**
 * Retry once, then report.
 *
 * A single failure is not an answer - it is one round trip that did not work.
 * The first one is logged at `error` level on the way past, because the retry
 * would otherwise hide a *deterministic* failure behind a working second
 * attempt, and then the only trace of the real mechanism is gone.
 */
function handleCheckFailure(err: unknown): void {
	const message = describeError(err);

	// One failure reaches here twice (the event and the promise rejection).
	// Answering the attempt rather than the signal keeps that from spending the
	// whole budget on a single failed round trip.
	if (attempt > 0 && failedAttempt === attempt) return;
	failedAttempt = attempt;

	if (attempt > 0 && attempt < MAX_CHECK_ATTEMPTS) {
		console.error(`[Updater] first check failed, retrying once: ${message}`);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			attempt += 1;
			runCheckAttempt();
		}, RETRY_DELAY_MS);
		// Node keeps the process alive for a pending timer; a retry must not
		// hold up quit.
		retryTimer.unref?.();
		return;
	}

	endCheckCycle();
	settleCheck({ status: "error", message });
}

/**
 * Wire up auto-update for the current platform.
 *
 *   - silent (Windows, Linux AppImage): download in the background, then tell
 *     the renderer it can restart-and-install.
 *   - notify (macOS, Linux .deb): only check the version feed and surface the
 *     newer release in the UI; the user updates out-of-band.
 *   - disabled (development): no-op.
 */
export function initAutoUpdater(getWindow: WindowAccessor): void {
	const isDev = process.env.NODE_ENV === "development";
	const isAppImage = Boolean(process.env.APPIMAGE);
	const strategy = resolveUpdateStrategy({
		platform: process.platform,
		isDev,
		isAppImage,
	});

	resolveWindow = getWindow;

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

	// The macOS notify path's other half: the installer cannot replace a bundle
	// whose processes are still running, so it has to quit Vayu itself - and
	// from a terminal that means an Apple Event, which macOS gates behind an
	// Automation consent prompt the user has to notice and approve.
	//
	// Quitting from in here needs no such permission and takes the ordinary
	// `before-quit` path in main.ts, which flushes pending renderer saves and
	// stops the engine and MCP server before exiting. So the app quitting itself
	// is strictly better than the script killing it, and the script's own quit
	// stays as the fallback for anyone who runs the command directly.
	ipcMain.handle("update:quitForUpdate", () => {
		app.quit();
	});

	if (strategy === "disabled") {
		console.log("[Updater] disabled (development)");
		return;
	}

	autoUpdater.autoDownload = strategy === "silent";
	autoUpdater.autoInstallOnAppQuit = strategy === "silent";
	autoUpdater.allowPrerelease = false;

	const send = (channel: string, payload: unknown) => {
		liveWindow()?.webContents.send(channel, payload);
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
		endCheckCycle();
		settleCheck({ status: "available", ...payload });
	});

	autoUpdater.on("update-downloaded", (info) => {
		send("update:downloaded", { version: info.version });
	});

	// Only surfaced for user-initiated checks; the periodic check stays silent.
	autoUpdater.on("update-not-available", () => {
		endCheckCycle();
		settleCheck({ status: "up-to-date", version: app.getVersion() });
	});

	autoUpdater.on("error", (err) => {
		console.error("[Updater] error:", err);
		handleCheckFailure(err);
	});

	updaterReady = true;

	// The startup and periodic checks retry on the same budget. They stay
	// silent - `settleCheck` answers nobody when no one is waiting - but the
	// startup one runs on the coldest network stack of the session, so it is
	// the attempt that most needs a second try.
	startCheckCycle();
	intervalTimer = setInterval(() => startCheckCycle(), CHECK_INTERVAL_MS);
}

/**
 * Show a dialog parented to the window the user is actually looking at.
 *
 * Parenting matters (a sheet on macOS, a modal owned by the window elsewhere),
 * but a missing window must not swallow the message: with no live window the
 * dialog is shown unparented rather than not at all, which is the macOS
 * all-windows-closed case for the menu's "Check for Updates…".
 */
function showUpdateDialog(
	options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
	const win = liveWindow();
	return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

/**
 * Announce an available release to a menu check that has no window to show the
 * banner in. The release-notes button is the only action the notify path has -
 * the update itself happens out-of-band there.
 */
function showAvailableDialog(version: string, url: string): void {
	void showUpdateDialog({
		type: "info",
		message: `Vayu ${version} is available`,
		detail: `You're on ${app.getVersion()}.`,
		buttons: ["OK", "Release notes"],
		defaultId: 0,
		cancelId: 0,
	}).then(({ response }) => {
		if (response === 1) void shell.openExternal(url);
	});
}

/**
 * Claim the check the user is waiting on, if any, so it can be answered exactly
 * once. Events fire for the periodic check too, so nothing waiting means there
 * is nothing to answer - that is the silent path doing its job, not a missed
 * result.
 */
function takePendingCheck(): PendingCheck | null {
	const pending = pendingCheck;
	if (!pending) return null;
	pendingCheck = null;
	clearTimeout(pending.timer);
	return pending;
}

/** Deliver the outcome of the check the user is waiting on, if any. */
function settleCheck(result: UpdateCheckResult): void {
	const pending = takePendingCheck();
	if (!pending) return;

	// The menu item has no UI of its own, so it reports through a native
	// dialog. The settings panel renders the same result in place, and a modal
	// on top of it would be redundant.
	if (pending.source === "menu") {
		if (result.status === "up-to-date") {
			void showUpdateDialog({
				type: "info",
				message: "You're up to date",
				detail: `Vayu ${result.version} is the latest version.`,
				buttons: ["OK"],
			});
		} else if (result.status === "error") {
			void showUpdateDialog({
				type: "error",
				message: "Couldn't check for updates",
				detail: result.message,
				buttons: ["OK"],
			});
		} else if (result.status === "available" && !liveWindow()) {
			// "available" normally needs no dialog - the banner is already
			// showing it. But the banner is a `webContents.send`, and with no
			// window there is nothing to send it to: the menu click would
			// otherwise find an update and say nothing at all. On macOS a
			// window-less app is the ordinary state, and the menu is still
			// there to click.
			showAvailableDialog(result.version, result.releaseUrl);
		}
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
		if (source === "menu") {
			void showUpdateDialog({
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
		// The budget covers the retry too, so a timeout ends the cycle - a
		// retry still in flight has nobody left to answer.
		endCheckCycle();
		settleCheck({ status: "error", message: "The update check timed out." });
	}, CHECK_TIMEOUT_MS);
	// Node keeps the process alive for a pending timer; this one must not hold
	// up quit if the user closes the window mid-check.
	timer.unref?.();
	pendingCheck = { source, settle, promise, timer };

	startCheckCycle();

	return promise;
}

/**
 * Stop the periodic check. Called from `will-quit` in main.ts, and by tests.
 *
 * The waiting check is settled without a dialog: the app is on its way out, and
 * a modal raised during teardown either flashes past unread or holds up the
 * quit. The caller still gets its answer, so no promise is left hanging.
 */
export function disposeAutoUpdater(): void {
	if (intervalTimer) {
		clearInterval(intervalTimer);
		intervalTimer = null;
	}
	endCheckCycle();
	takePendingCheck()?.settle({ status: "error", message: "The update check was cancelled." });
	resolveWindow = null;
}
