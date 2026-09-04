/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's progress on the taskbar button and the Dock icon (issue #1362).
 *
 * While a load test runs, the only place its progress exists is the dashboard
 * inside the window. A user who started a thirty-minute run and switched to
 * their editor - the case the wake lock (#1357) and the system notifications
 * (#1358) also address - has nothing to glance at. Windows paints a fill on the
 * taskbar button and macOS draws a bar on the Dock icon from one Electron call.
 *
 * **Two platforms, not three.** Electron 44 removed Unity launcher support, and
 * `BrowserWindow.setProgressBar` now "continues functioning on Windows and
 * macOS only". So on Linux this module paints nothing at all rather than
 * calling into a no-op, which is also what keeps the Linux branch honest in a
 * test instead of passing by accident on the CI runner's own platform.
 *
 * The renderer decides *what* a run's progress is - only it holds the run's
 * denominator - and this side decides *how*, which is the same split
 * `notify.ts` uses and the reason no platform detail reaches React.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do. The Electron surfaces it
 * needs arrive as arguments for the same reason.
 */

import { createRendererWatch, type IpcEventLike } from "./renderer-watch.js";

export const RUN_PROGRESS_CHANNEL = "runs:progress";

/**
 * How long the failed state stays on the taskbar before it clears (Windows).
 *
 * Long enough to be seen by someone glancing over, short enough that the button
 * is not still red when the user comes back and reads the notification instead.
 */
export const RUN_PROGRESS_ERROR_FLASH_MS = 2000;

/**
 * What the OS should show for the run the renderer has put in front.
 *
 * `value` is null for a run with no denominator - an open-ended load test, or a
 * collection run, whose plan length only the engine resolves. Windows can say
 * "something is running" for those; macOS has no indeterminate Dock bar and
 * shows nothing.
 */
export type RunProgressUpdate =
	{ state: "running"; value: number | null } | { state: "failed" } | { state: "idle" };

/** Electron's own progress modes, of which this uses three. */
type ProgressMode = "none" | "normal" | "indeterminate" | "error" | "paused";

/** The slice of `BrowserWindow` this needs, so a test can pass a fake. */
export interface ProgressWindowLike {
	setProgressBar(progress: number, options?: { mode: ProgressMode }): void;
}

export interface RunProgressDeps {
	/**
	 * The window as it is right now, or null. Read per call rather than
	 * captured: on macOS the app outlives its window, and a captured one would
	 * be painted after it was destroyed.
	 */
	window: () => ProgressWindowLike | null;
	/** Defaults to the host's. Injected so both branches can be tested. */
	platform?: NodeJS.Platform;
	/** Timer for the error flash, injected so a test need not wait two seconds. */
	after?: (ms: number, fn: () => void) => void;
}

export interface RunProgressPainter {
	/** Paint what the renderer asked for, under this platform's rules. */
	apply(update: RunProgressUpdate): void;
	/** Take the indicator away, because nothing is running or nobody is left to say. */
	clear(): void;
}

/** Electron's clear value. `-1` removes the indicator on both platforms. */
const CLEARED = -1;

/** Any value above 1 with `indeterminate` reads as the mode, not as a fraction. */
const INDETERMINATE = 2;

function clampFraction(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function createRunProgress(deps: RunProgressDeps): RunProgressPainter {
	const platform = deps.platform ?? process.platform;
	const after = deps.after ?? ((ms: number, fn: () => void) => void setTimeout(fn, ms));
	/** See the header: Electron 44 paints this on Windows and macOS and nowhere else. */
	const paints = platform === "win32" || platform === "darwin";

	/**
	 * Bumped by every paint, so the error flash's own clear can tell whether it
	 * is still the last thing that happened. Without it, a run that fails while
	 * another is still going would wipe that run's bar two seconds later.
	 */
	let generation = 0;

	function set(progress: number, mode?: ProgressMode): void {
		const window = deps.window();
		if (!window) return;
		if (mode) window.setProgressBar(progress, { mode });
		else window.setProgressBar(progress);
	}

	function paintRunning(value: number | null): void {
		if (value !== null) {
			set(clampFraction(value));
			return;
		}
		// Windows says "running, length unknown"; macOS has no such Dock bar, so
		// it shows nothing. Cleared rather than left alone: a determinate bar may
		// already be painted from the run this one took over from, and a frozen
		// fraction is worse than no bar at all.
		if (platform === "win32") set(INDETERMINATE, "indeterminate");
		else set(CLEARED);
	}

	function paintFailed(): void {
		if (platform !== "win32") {
			// macOS has no error mode. The notification (#1358) is what says why.
			set(CLEARED);
			return;
		}
		set(1, "error");
		const flash = generation;
		after(RUN_PROGRESS_ERROR_FLASH_MS, () => {
			if (generation !== flash) return;
			set(CLEARED);
		});
	}

	return {
		apply(update: RunProgressUpdate): void {
			if (!paints) return;
			generation++;
			switch (update.state) {
				case "running":
					paintRunning(update.value);
					return;
				case "failed":
					paintFailed();
					return;
				case "idle":
					set(CLEARED);
					return;
			}
		},

		clear(): void {
			if (!paints) return;
			generation++;
			set(CLEARED);
		},
	};
}

/** The slice of `ipcMain` this channel needs. */
export interface IpcLike {
	on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
}

/**
 * Read one message off the channel, or `null` for anything that is not one.
 *
 * A malformed payload is dropped rather than painted: the values reach an OS
 * surface that outlives the window, and the one thing worse than no bar is a
 * frozen one nothing will come back to clear.
 */
export function parseRunProgressUpdate(raw: unknown): RunProgressUpdate | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { state, value } = raw as { state?: unknown; value?: unknown };
	if (state === "failed" || state === "idle") return { state };
	if (state !== "running") return null;
	if (value === null || value === undefined) return { state: "running", value: null };
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return { state: "running", value };
}

/**
 * Wire the channel, and make the indicator die with the renderer that asked for
 * it.
 *
 * The teardown is not a nicety: a renderer that crashes or reloads mid-run never
 * gets to send its terminal message, and without this the taskbar keeps a bar
 * for a run that is gone until the app quits.
 */
export function registerRunProgressIpc(ipc: IpcLike, painter: RunProgressPainter): void {
	const watchOwner = createRendererWatch(() => painter.clear());

	ipc.on(RUN_PROGRESS_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		const update = parseRunProgressUpdate(args[0]);
		if (!update) {
			console.warn("[run-progress] ignored a message that is not an update", args[0]);
			return;
		}
		watchOwner(event.sender);
		painter.apply(update);
	});
}
