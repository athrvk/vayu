/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Manual update checks.
 *
 * electron-updater answers through events, not through the promise
 * `checkForUpdates()` returns, so the result has to be stitched back onto the
 * caller. The failure modes that matter here are all about a caller left
 * waiting: an event that never arrives, a second click starting a competing
 * check, or a window that closes mid-check. Each one strands a spinner in
 * Settings that the user cannot clear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { UPDATE_CHECK_INTERVAL_MS, UPDATE_STARTUP_CHECK_DELAY_MS } from "./constants.js";

type Handler = (arg: unknown) => void;

const listeners = new Map<string, Handler>();
const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
const checkForUpdates = vi.fn().mockResolvedValue(null);
const quit = vi.fn();
const openExternal = vi.fn().mockResolvedValue(undefined);

vi.mock("electron", () => ({
	app: { getVersion: () => "0.9.0", quit: (...args: unknown[]) => quit(...args) },
	dialog: {
		showMessageBox: (...args: unknown[]) => showMessageBox(...args),
	},
	ipcMain: {
		handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
			ipcHandlers.set(channel, fn);
		},
	},
	shell: { openExternal: (...args: unknown[]) => openExternal(...args) },
}));

vi.mock("electron-updater", () => ({
	default: {
		autoUpdater: {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowPrerelease: false,
			on: (event: string, handler: Handler) => {
				listeners.set(event, handler);
			},
			checkForUpdates: () => checkForUpdates(),
			quitAndInstall: vi.fn(),
		},
	},
}));

interface FakeWindow {
	destroyed: boolean;
	isDestroyed: () => boolean;
	webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(): FakeWindow {
	const win: FakeWindow = {
		destroyed: false,
		isDestroyed: () => win.destroyed,
		webContents: { send: vi.fn() },
	};
	return win;
}

/**
 * The window as main.ts owns it: one variable the updater reads through, not a
 * reference it is handed once. Tests move it the way the app does - closed on
 * the X, rebuilt on a macOS dock-activate.
 */
let currentWindow: FakeWindow | null = null;
const getWindow = (() => currentWindow) as unknown as Parameters<
	typeof import("./updater.js").initAutoUpdater
>[0];

/** Re-import with fresh module state - the updater keeps module-level state. */
async function loadUpdater(platform: NodeJS.Platform = "win32") {
	vi.resetModules();
	listeners.clear();
	ipcHandlers.clear();
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	return import("./updater.js");
}

const realPlatform = process.platform;

beforeEach(() => {
	showMessageBox.mockClear().mockResolvedValue({ response: 0 });
	checkForUpdates.mockClear().mockResolvedValue(null);
	openExternal.mockClear();
	currentWindow = makeWindow();
	vi.stubEnv("NODE_ENV", "production");
});

/**
 * Fail the attempt in flight the way electron-updater does: the `error` event
 * and the `checkForUpdates()` rejection both report the same failure.
 */
function failAttempt(err: Error): void {
	listeners.get("error")?.(err);
}

/** Let the retry's delay elapse so the second attempt runs. */
async function letRetryRun(): Promise<void> {
	await vi.advanceTimersByTimeAsync(2_000);
}

/** Let the launch delay elapse so the session's first check runs. */
async function letStartupDelayPass(): Promise<void> {
	await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("checkForUpdatesNow", () => {
	it("resolves up-to-date without claiming a version it does not have", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});
		await expect(pending).resolves.toEqual({ status: "up-to-date", version: "0.9.0" });
	});

	it("resolves with the available release and its notes URL", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await expect(pending).resolves.toMatchObject({
			status: "available",
			version: "1.0.0",
			releaseUrl: expect.stringContaining("v1.0.0"),
		});
	});

	it("resolves with the error rather than hanging", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		failAttempt(new Error("ENOTFOUND"));
		await letRetryRun();
		failAttempt(new Error("ENOTFOUND"));
		await expect(pending).resolves.toEqual({ status: "error", message: "ENOTFOUND" });
	});

	it("joins an in-flight check instead of starting a second one", async () => {
		// Two clicks - the menu item and the settings button, or an impatient
		// double-click - must not race two checks whose events interleave.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		checkForUpdates.mockClear();

		const first = checkForUpdatesNow("renderer");
		const second = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});

		expect(checkForUpdates).toHaveBeenCalledTimes(1);
		await expect(first).resolves.toEqual(await second);
	});

	it("gives up rather than waiting forever for an event that never comes", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pending).resolves.toEqual({
			status: "error",
			message: "The update check timed out.",
		});
	});

	it("settles a check left waiting at teardown", async () => {
		const { initAutoUpdater, checkForUpdatesNow, disposeAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		disposeAutoUpdater();
		await expect(pending).resolves.toMatchObject({ status: "error" });
	});

	it("reports unavailable, not failure, when the updater never started", async () => {
		// Development builds have no release feed. "Couldn't check for updates"
		// would read as something being broken.
		vi.stubEnv("NODE_ENV", "development");
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		await expect(checkForUpdatesNow("renderer")).resolves.toMatchObject({
			status: "unavailable",
		});
	});

	it("registers the renderer channels even when updates are disabled", async () => {
		// The settings panel invokes `update:check` on every platform. Without a
		// handler the invoke rejects with "No handler registered", which reads
		// like a bug rather than "this is a dev build".
		vi.stubEnv("NODE_ENV", "development");
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		expect([...ipcHandlers.keys()]).toEqual(
			expect.arrayContaining([
				"update:check",
				"update:restartToInstall",
				"update:openReleasePage",
			])
		);
		await expect(ipcHandlers.get("update:check")?.(null)).resolves.toMatchObject({
			status: "unavailable",
		});
	});
});

describe("when the session's first check runs", () => {
	// On Windows and the Linux AppImage a check that finds a release downloads it
	// on the spot, and `initAutoUpdater` is called moments after the window is
	// created - so the transfer used to start at t=0 of a launch, against the
	// user's own API traffic and the engine's startup disk work.

	it("holds the first check back rather than starting one at launch", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);

		expect(checkForUpdates).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_CHECK_DELAY_MS - 1);
		expect(checkForUpdates).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("waits on the notify platforms too, so there is one timing to reason about", async () => {
		// macOS only fetches the feed, which is cheap - but a second timing rule
		// would be a second thing to keep true.
		vi.useFakeTimers();
		const { initAutoUpdater } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);

		expect(checkForUpdates).not.toHaveBeenCalled();
		await letStartupDelayPass();
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("lets a check the user asks for during the wait stand in for it", async () => {
		// Settings → General, or the menu item, moments after launch: the answer
		// is the one the startup check would have got, so running it again when
		// the delay elapses would be the same question twice.
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);

		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});
		await expect(pending).resolves.toMatchObject({ status: "up-to-date" });

		await letStartupDelayPass();
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("drops the waiting check when the app quits before it comes due", async () => {
		// `will-quit` runs while the delay is still pending on any launch shorter
		// than a minute - the check must not fire into a torn-down updater.
		vi.useFakeTimers();
		const { initAutoUpdater, disposeAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);

		disposeAutoUpdater();
		await letStartupDelayPass();

		expect(checkForUpdates).not.toHaveBeenCalled();
	});

	it("leaves the 6h cycle on its own clock", async () => {
		// The delay moves the first check, not the interval: the second check of
		// the session still lands 6h after launch, not 6h after the first one.
		vi.useFakeTimers();
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);

		await letStartupDelayPass();
		listeners.get("update-not-available")?.({});

		// Up to a millisecond before the interval is due, the first check is still
		// the only one - the delay must not have moved this boundary with it.
		await vi.advanceTimersByTimeAsync(
			UPDATE_CHECK_INTERVAL_MS - UPDATE_STARTUP_CHECK_DELAY_MS - 1
		);
		expect(checkForUpdates).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(checkForUpdates).toHaveBeenCalledTimes(2);
	});
});

describe("one transient is not the answer", () => {
	// A mac check is three sequential HTTPS requests through Chromium's net
	// stack, and the first one of the session runs on the coldest possible
	// stack. Treating that attempt's failure as final is what made "check for
	// updates fails, click again and it works" reproducible.

	it("retries once, and answers with the retry's outcome", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");

		failAttempt(new Error("ERR_NETWORK_CHANGED"));
		await letRetryRun();
		listeners.get("update-not-available")?.({});

		// Not "ERR_NETWORK_CHANGED": the user never sees a failure the second
		// round trip disproved.
		await expect(pending).resolves.toEqual({ status: "up-to-date", version: "0.9.0" });
	});

	it("reports one error, and one dialog, when the retry fails too", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("menu");

		failAttempt(new Error("ENOTFOUND"));
		await letRetryRun();
		failAttempt(new Error("ENOTFOUND"));

		await expect(pending).resolves.toMatchObject({ status: "error" });
		expect(showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("spends one attempt on a failure reported twice", async () => {
		// electron-updater emits `error` *and* rejects `checkForUpdates()` for
		// the same failure. Counting signals rather than attempts would burn
		// the whole budget on a single failed round trip, leaving no retry.
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		checkForUpdates.mockClear().mockRejectedValue(new Error("ENOTFOUND"));

		const pending = checkForUpdatesNow("renderer");
		await vi.advanceTimersByTimeAsync(0); // the rejection lands
		failAttempt(new Error("ENOTFOUND")); // ...and the event for the same failure
		await letRetryRun();
		await vi.advanceTimersByTimeAsync(0); // the retry's rejection lands

		await expect(pending).resolves.toMatchObject({ status: "error" });
		expect(checkForUpdates).toHaveBeenCalledTimes(2);
	});

	it("retries the check a manual click joined", async () => {
		// The join is the amplifier: a click that lands while the startup check
		// is in flight inherits its fate. It has to inherit the retry too.
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		// The click has to land on the startup check itself, so let the launch
		// delay pass first: before it does there is a timer, not a check, and the
		// click would simply start its own cycle.
		await letStartupDelayPass();
		const first = checkForUpdatesNow("renderer");
		const joined = checkForUpdatesNow("renderer");

		failAttempt(new Error("ERR_NETWORK_CHANGED"));
		await letRetryRun();
		listeners.get("update-available")?.({ version: "1.0.0" });

		await expect(first).resolves.toMatchObject({ status: "available", version: "1.0.0" });
		await expect(joined).resolves.toEqual(await first);
	});

	it("keeps one timeout budget across the retry", async () => {
		// The user clicked once, so the wait they can see stays bounded by one
		// number - the retry runs inside it, not after it.
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");

		failAttempt(new Error("ERR_NETWORK_CHANGED"));
		await vi.advanceTimersByTimeAsync(30_000); // the retry ran, and never answered

		await expect(pending).resolves.toEqual({
			status: "error",
			message: "The update check timed out.",
		});
	});

	it("retries the periodic check without surfacing anything", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		await letStartupDelayPass(); // the startup check is in flight from here
		checkForUpdates.mockClear();

		// Nobody is waiting on the startup check - it still gets its retry.
		failAttempt(new Error("ERR_NETWORK_CHANGED"));
		await letRetryRun();

		expect(checkForUpdates).toHaveBeenCalledTimes(1);
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("names the error code so the next report arrives diagnosable", async () => {
		// electron-updater raises coded errors; the code says who is at fault in
		// a way the message alone does not. It has to reach the panel, which
		// prints `message` and nothing else.
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const coded = Object.assign(new Error("Cannot find latest-mac.yml"), {
			code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
		});

		const pending = checkForUpdatesNow("renderer");
		failAttempt(coded);
		await letRetryRun();
		failAttempt(coded);

		await expect(pending).resolves.toEqual({
			status: "error",
			message: "Cannot find latest-mac.yml (ERR_UPDATER_LATEST_VERSION_NOT_FOUND)",
		});
	});

	it("does not repeat a code the message already carries", async () => {
		vi.useFakeTimers();
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const err = Object.assign(new Error("net::ERR_NETWORK_CHANGED"), {
			code: "net::ERR_NETWORK_CHANGED",
		});

		const pending = checkForUpdatesNow("renderer");
		failAttempt(err);
		await letRetryRun();
		failAttempt(err);

		await expect(pending).resolves.toEqual({
			status: "error",
			message: "net::ERR_NETWORK_CHANGED",
		});
	});
});

describe("the macOS update instruction", () => {
	// macOS never installs an update in-app - an ad-hoc signature gives
	// Squirrel.Mac nothing to verify, so the strategy is "notify" and the
	// notification hands the user a command to paste. That command is therefore
	// the whole macOS update path, and it lives in two places: here and the
	// README. When the installer moved to the docs site the README was updated
	// and this string was not, because it is assembled from a template literal
	// that no `raw.githubusercontent.com/athrvk` grep can see.
	const [readmePath] = ROOT_READING_GUARDS.macUpdateCommand.paths.map(fromRepoRoot);
	const readme = readFileSync(readmePath, "utf8");
	const documented = readme.match(/^bash -c "\$\(curl -fsSL \S+install\.sh\)"$/m)?.[0];

	it("finds a command in the README to compare against", () => {
		// Without this the assertion below passes vacuously if the README's
		// macOS section is ever reworded past the pattern.
		expect(documented).toMatch(/install\.sh/);
	});

	it("can quit the app so the pasted command can replace it", async () => {
		// The installer cannot replace a bundle whose processes are running. It
		// can quit Vayu itself, but only through an Apple Event that macOS gates
		// behind an Automation consent prompt - quitting from in here needs no
		// permission and takes main.ts's before-quit path, which flushes saves
		// and stops the engine first.
		quit.mockClear();
		const { initAutoUpdater } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		await ipcHandlers.get("update:quitForUpdate")?.(null);
		expect(quit).toHaveBeenCalled();
	});

	it("hands macOS users exactly the command the README publishes", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await expect(pending).resolves.toMatchObject({
			strategy: "notify",
			installCommand: documented,
		});
	});
});

describe("where the result is delivered", () => {
	it("shows a native dialog for the menu, which has no UI of its own", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("menu");
		listeners.get("update-not-available")?.({});
		await pending;
		expect(showMessageBox).toHaveBeenCalled();
	});

	it("shows no dialog for the settings panel, which renders the result itself", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});
		await pending;
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("parents the dialog to the window that is open now", async () => {
		// The first window is gone and a dock-activate built a replacement. A
		// dialog parented to the dead one is unowned; parented to the live one it
		// is the sheet the user expects.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		const firstWindow = currentWindow;

		firstWindow!.destroyed = true;
		const reopened = makeWindow();
		currentWindow = reopened;

		const pending = checkForUpdatesNow("menu");
		listeners.get("update-not-available")?.({});
		await pending;

		expect(showMessageBox).toHaveBeenCalledWith(reopened, expect.anything());
	});

	it("still answers the menu when no window is open at all", async () => {
		// macOS keeps the app running with every window closed, and the menu's
		// "Check for Updates…" is still there to click. Dropping the answer
		// because there is nothing to parent to would leave that click silent.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		currentWindow = null;

		const pending = checkForUpdatesNow("menu");
		listeners.get("update-not-available")?.({});
		await pending;

		expect(showMessageBox).toHaveBeenCalledWith(
			expect.objectContaining({ message: "You're up to date" })
		);
	});

	it("leaves an available update to the banner while a window is live", async () => {
		// The banner is already saying it; a modal on top would be the same news
		// twice.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("menu");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await pending;
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("tells the menu about an available update when there is no window", async () => {
		// The banner is a `webContents.send`, so with no window it goes nowhere -
		// and on macOS a window-less app is the ordinary state, with the menu
		// still there to click. Without a dialog the click finds an update and
		// reports nothing at all.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		currentWindow = null;

		const pending = checkForUpdatesNow("menu");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await pending;

		expect(showMessageBox).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Vayu 1.0.0 is available" })
		);
	});

	it("opens the release notes when that dialog's button is chosen", async () => {
		// The notify path updates out-of-band, so the release page is the only
		// action the dialog can offer.
		showMessageBox.mockResolvedValue({ response: 1 });
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		currentWindow = null;

		const pending = checkForUpdatesNow("menu");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await pending;
		await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));

		expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("v1.0.0"));
	});

	it("stays silent for the periodic check, which nobody is waiting on", async () => {
		// Fake timers so the silent retry this schedules cannot fire into a
		// later test - `afterEach` discards them.
		vi.useFakeTimers();
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		await letStartupDelayPass(); // a silent cycle is actually in flight
		// No manual check in flight - the interval's events must not pop a
		// dialog over whatever the user is doing.
		listeners.get("update-not-available")?.({});
		listeners.get("error")?.(new Error("offline"));
		await letRetryRun();
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("cancels a menu check at teardown without raising a dialog", async () => {
		// `will-quit` settles the waiting check so nothing hangs, but the app is
		// already going: a modal raised here either flashes past unread or holds
		// up the quit.
		const { initAutoUpdater, checkForUpdatesNow, disposeAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		const pending = checkForUpdatesNow("menu");

		disposeAutoUpdater();

		await expect(pending).resolves.toMatchObject({ status: "error" });
		expect(showMessageBox).not.toHaveBeenCalled();
	});
});

describe("which window the update events reach", () => {
	it("sends to the window that exists now, not the one open at startup", async () => {
		// macOS keeps the app alive when its window closes, and a dock-activate
		// builds a new one. Holding the startup window would drop every periodic
		// event from then on - and on the notify path that pushed banner is the
		// entire passive update path, so update discovery would stop for the rest
		// of the session.
		const { initAutoUpdater } = await loadUpdater("darwin");
		initAutoUpdater(getWindow);
		const firstWindow = currentWindow!;

		firstWindow.destroyed = true;
		const reopened = makeWindow();
		currentWindow = reopened;

		listeners.get("update-available")?.({ version: "1.0.0" });

		expect(reopened.webContents.send).toHaveBeenCalledWith(
			"update:available",
			expect.objectContaining({ version: "1.0.0" })
		);
		expect(firstWindow.webContents.send).not.toHaveBeenCalled();
	});

	it("drops the event rather than sending into a destroyed window", async () => {
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(getWindow);
		const win = currentWindow!;
		win.destroyed = true;

		listeners.get("update-downloaded")?.({ version: "1.0.0" });

		expect(win.webContents.send).not.toHaveBeenCalled();
	});
});
