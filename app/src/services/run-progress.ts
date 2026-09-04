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
 * and holds the one rule main cannot answer: **an application has one progress
 * indicator, and two runs can be live at once.** A load run and a collection run
 * each report under their own key; the most recently started of them owns the
 * indicator, and when it ends the other takes it back rather than the OS being
 * left with a bar for a run that finished. That is the same reason
 * `wake-lock.ts` is keyed rather than copied into both run services.
 *
 * Nothing here throttles: a caller reports off the metrics flush, which is
 * already the live-refresh cadence (`throttled-batcher.ts`), so a second timer
 * would only add a second answer to "how often does this paint".
 *
 * `report`/`fail`/`clear` are fire-and-forget by design - no run may wait on the
 * OS to draw a rectangle.
 */

import type { RunProgressUpdate } from "@/types/electron";

/** The two runs that can own the indicator, matching `WAKE_LOCK_KEYS`. */
export const RUN_PROGRESS_KEYS = {
	loadRun: "load-run",
	collectionRun: "collection-run",
} as const;

export type RunProgressKey = (typeof RUN_PROGRESS_KEYS)[keyof typeof RUN_PROGRESS_KEYS];

/**
 * Live runs and their last reported fraction, in the order they started. A
 * `Map` keeps that order across an update to a key already in it, so the owner
 * is simply the last one added.
 */
const live = new Map<RunProgressKey, number | null>();

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

/** The most recently started run still live, or null when none is. */
function owner(): RunProgressKey | null {
	let last: RunProgressKey | null = null;
	for (const key of live.keys()) last = key;
	return last;
}

/** Paint whoever owns the indicator now, or take it away when nobody does. */
function paintOwner(): void {
	const key = owner();
	if (!key) {
		send({ state: "idle" });
		return;
	}
	send({ state: "running", value: live.get(key) ?? null });
}

export const runProgress = {
	/**
	 * Say where `key`'s run is: a 0..1 fraction, or null for a run with no
	 * denominator, which shows as indeterminate where the platform has one.
	 *
	 * The first report for a key is what makes that run the owner, so a run
	 * reports once when it starts rather than waiting for its first tick.
	 */
	report(key: RunProgressKey, value: number | null): void {
		// A key not seen before lands at the end of the map and is the owner from
		// this call on; one already there keeps its place. Either way a key that
		// is live but not in front has its value recorded and nothing else - it
		// is what gets painted when the run in front ends.
		live.set(key, value);
		if (owner() === key) paintOwner();
	},

	/**
	 * `key`'s run ended badly. The indicator says so - briefly, and only where a
	 * platform has a failed state - unless another run is still going, whose
	 * progress is the more useful thing to be showing.
	 */
	fail(key: RunProgressKey): void {
		const wasOwner = owner() === key;
		if (!live.delete(key) || !wasOwner) return;
		if (live.size > 0) {
			paintOwner();
			return;
		}
		send({ state: "failed" });
	},

	/** `key`'s run is over. A key that is not live is a no-op. */
	clear(key: RunProgressKey): void {
		if (!live.delete(key)) return;
		paintOwner();
	},
};
