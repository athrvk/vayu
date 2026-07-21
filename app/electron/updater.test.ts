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

type Handler = (arg: unknown) => void;

const listeners = new Map<string, Handler>();
const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const showMessageBox = vi.fn().mockResolvedValue({ response: 0 });
const checkForUpdates = vi.fn().mockResolvedValue(null);

vi.mock("electron", () => ({
	app: { getVersion: () => "0.9.0" },
	dialog: {
		showMessageBox: (...args: unknown[]) => showMessageBox(...args),
	},
	ipcMain: {
		handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
			ipcHandlers.set(channel, fn);
		},
	},
	shell: { openExternal: vi.fn() },
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

const win = {
	isDestroyed: () => false,
	webContents: { send: vi.fn() },
} as unknown as Parameters<typeof import("./updater.js").initAutoUpdater>[0];

/** Re-import with fresh module state — the updater keeps module-level state. */
async function loadUpdater(platform: NodeJS.Platform = "win32") {
	vi.resetModules();
	listeners.clear();
	ipcHandlers.clear();
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	return import("./updater.js");
}

const realPlatform = process.platform;

beforeEach(() => {
	showMessageBox.mockClear();
	checkForUpdates.mockClear().mockResolvedValue(null);
	vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("checkForUpdatesNow", () => {
	it("resolves up-to-date without claiming a version it does not have", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});
		await expect(pending).resolves.toEqual({ status: "up-to-date", version: "0.9.0" });
	});

	it("resolves with the available release and its notes URL", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-available")?.({ version: "1.0.0" });
		await expect(pending).resolves.toMatchObject({
			status: "available",
			version: "1.0.0",
			releaseUrl: expect.stringContaining("v1.0.0"),
		});
	});

	it("resolves with the error rather than hanging", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("error")?.(new Error("ENOTFOUND"));
		await expect(pending).resolves.toEqual({ status: "error", message: "ENOTFOUND" });
	});

	it("joins an in-flight check instead of starting a second one", async () => {
		// Two clicks — the menu item and the settings button, or an impatient
		// double-click — must not race two checks whose events interleave.
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
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
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(pending).resolves.toEqual({
			status: "error",
			message: "The update check timed out.",
		});
	});

	it("settles a check left waiting at teardown", async () => {
		const { initAutoUpdater, checkForUpdatesNow, disposeAutoUpdater } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		disposeAutoUpdater();
		await expect(pending).resolves.toMatchObject({ status: "error" });
	});

	it("reports unavailable, not failure, when the updater never started", async () => {
		// Development builds have no release feed. "Couldn't check for updates"
		// would read as something being broken.
		vi.stubEnv("NODE_ENV", "development");
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
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
		initAutoUpdater(win);
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

describe("where the result is delivered", () => {
	it("shows a native dialog for the menu, which has no UI of its own", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("menu");
		listeners.get("update-not-available")?.({});
		await pending;
		expect(showMessageBox).toHaveBeenCalled();
	});

	it("shows no dialog for the settings panel, which renders the result itself", async () => {
		const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater();
		initAutoUpdater(win);
		const pending = checkForUpdatesNow("renderer");
		listeners.get("update-not-available")?.({});
		await pending;
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("stays silent for the periodic check, which nobody is waiting on", async () => {
		const { initAutoUpdater } = await loadUpdater();
		initAutoUpdater(win);
		// No manual check in flight — the interval's events must not pop a
		// dialog over whatever the user is doing.
		listeners.get("update-not-available")?.({});
		listeners.get("error")?.(new Error("offline"));
		expect(showMessageBox).not.toHaveBeenCalled();
	});
});
