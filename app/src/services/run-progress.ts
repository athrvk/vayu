/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer half of the taskbar and Dock progress indicator (issue #1362).
 *
 * `electron/run-progress.ts` decides how a platform paints an update - and that
 * two of the three paint anything at all. This side decides what the update is,
 * and holds the one rule main cannot answer: **which run the indicator is for.**
 *
 * There is only ever one, and it is whichever run the renderer is currently
 * watching. `sse-client.ts` is a singleton with one `EventSource` - "one client
 * for both run types, because there is one stream" - so a second
 * `startMonitoring`, from either run service, closes the first stream where it
 * stands. The superseded run keeps running on the engine, but nothing here sees
 * another tick of it, and its terminal handlers never fire.
 *
 * So `report` takes the indicator over, and `fail`/`clear` from a run that has
 * already been superseded are ignored. Without that guard the older run's stop -
 * the dashboard calls `stopMonitoring` for a run it finds already finished -
 * would wipe the bar of the run that is actually being watched.
 *
 * Nothing here throttles: a caller reports off the metrics flush, which is
 * already the live-refresh cadence (`throttled-batcher.ts`), so a second timer
 * would only add a second answer to "how often does this paint".
 *
 * `report`/`fail`/`clear` are fire-and-forget by design - no run may wait on the
 * OS to draw a rectangle.
 */

import type { RunProgressUpdate } from "@/types/electron";

/** The two kinds of run that report progress, matching `WAKE_LOCK_KEYS`. */
export const RUN_PROGRESS_KEYS = {
	loadRun: "load-run",
	collectionRun: "collection-run",
} as const;

export type RunProgressKey = (typeof RUN_PROGRESS_KEYS)[keyof typeof RUN_PROGRESS_KEYS];

/** The run the indicator is showing, or null when it is showing nothing. */
let shownFor: RunProgressKey | null = null;

/**
 * The last running update sent, so an unmoved fraction is not re-sent on every
 * flush. Terminal updates are always sent: they are rare, and one that was
 * skipped would leave a bar behind.
 */
let lastRunningSent: string | null = null;

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * The preload bridge, or nothing outside Electron - the same guard the rest of
 * the renderer uses for an Electron-only method.
 */
function bridge(): Bridge | undefined {
	if (typeof window === "undefined") return undefined;
	const api = window.electronAPI;
	return api?.setRunProgress ? api : undefined;
}

function send(update: RunProgressUpdate): void {
	const api = bridge();
	if (!api) return;

	if (update.state === "running") {
		const fingerprint = `${update.value}`;
		if (fingerprint === lastRunningSent) return;
		lastRunningSent = fingerprint;
	} else {
		lastRunningSent = null;
	}

	try {
		api.setRunProgress(update);
	} catch (error: unknown) {
		// The dashboard is still showing this run's progress; a taskbar that did
		// not repaint costs the user nothing they can act on.
		console.warn("[run-progress] update could not be sent", error);
	}
}

export const runProgress = {
	/**
	 * Say where `key`'s run is: a 0..1 fraction, or null for a run with no
	 * denominator, which shows as indeterminate where the platform has one.
	 *
	 * Reporting takes the indicator over, because watching this run is what
	 * stopped the renderer watching any other.
	 */
	report(key: RunProgressKey, value: number | null): void {
		shownFor = key;
		send({ state: "running", value });
	},

	/**
	 * `key`'s run ended badly. The indicator says so - briefly, and only where a
	 * platform has a failed state.
	 */
	fail(key: RunProgressKey): void {
		if (shownFor !== key) return;
		shownFor = null;
		send({ state: "failed" });
	},

	/** `key`'s run is over. A run the indicator is not showing is a no-op. */
	clear(key: RunProgressKey): void {
		if (shownFor !== key) return;
		shownFor = null;
		send({ state: "idle" });
	},
};
