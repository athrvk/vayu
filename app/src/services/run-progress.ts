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
 * another tick of it, and its *terminal* handlers never fire - it did not end.
 * What does fire is the hand-off (issue #1417): the displaced service is told,
 * and gives the claim up there.
 *
 * So a run `claim`s the indicator when the renderer starts watching it, and
 * every later call names the run it speaks for: one that no longer holds the
 * claim is ignored, whether it reports, fails or clears. Without that guard the
 * older run's stop - the dashboard calls `stopMonitoring` for a run it finds
 * already finished - would wipe the bar of the run that is actually being
 * watched.
 *
 * The claim is a run, not a `RunProgressKey` (issue #1405). The key names a
 * *kind* of run and the thing that owns the indicator is one run, so keying by
 * kind left two gaps: two runs of the same kind, where the superseded one's
 * terminal calls pass the guard outright, and a stranded reporter, where a
 * service that has lost the stream can still paint. The displaced service is
 * now told the moment it loses the stream and clears its own claim there
 * (issue #1417), but that does not retire the guard: a batched flush already in
 * flight lands *after* the hand-off, and a run of the same kind as the one that
 * took over would otherwise pass the guard on its way out. The claim is what
 * tells those apart from the live run; the hand-off is what stops the bar being
 * left standing when nothing else would clear it.
 *
 * Nothing here throttles: a caller reports off the metrics flush, which is
 * already the live-refresh cadence (`throttled-batcher.ts`), so a second timer
 * would only add a second answer to "how often does this paint".
 *
 * Every call here is fire-and-forget by design - no run may wait on the OS to
 * draw a rectangle.
 */

import type { RunProgressUpdate } from "@/types/electron";

/** The two kinds of run that report progress, matching `WAKE_LOCK_KEYS`. */
export const RUN_PROGRESS_KEYS = {
	loadRun: "load-run",
	collectionRun: "collection-run",
} as const;

export type RunProgressKey = (typeof RUN_PROGRESS_KEYS)[keyof typeof RUN_PROGRESS_KEYS];

/** The run the indicator is showing, or null when it is showing nothing. */
let shownFor: { key: RunProgressKey; runId: string } | null = null;

/**
 * Whether `runId` is the run the indicator is showing.
 *
 * The run id is the identity - it is unique across both kinds, since every run
 * is one `POST /runs` - and the key rides with it so that a caller naming a run
 * under the wrong kind cannot paint on the strength of the id alone.
 *
 * A caller with no run id at all holds no claim: `null` here is a service whose
 * run has already been forgotten, and the indicator belongs to whichever run is
 * being watched now.
 */
function isShown(key: RunProgressKey, runId: string | null): boolean {
	return shownFor !== null && shownFor.key === key && shownFor.runId === runId;
}

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
	 * Take the indicator for `runId`, because watching this run is what stopped
	 * the renderer watching any other.
	 *
	 * It starts with no fraction - nothing has ticked yet, so how far along the
	 * run is has no answer, and "running, length unknown" is the honest one. The
	 * run's first `report` replaces it where the run has a denominator at all.
	 */
	claim(key: RunProgressKey, runId: string): void {
		shownFor = { key, runId };
		send({ state: "running", value: null });
	},

	/**
	 * Say where `runId` is: a 0..1 fraction, or null for a run with no
	 * denominator, which shows as indeterminate where the platform has one.
	 *
	 * A run that no longer holds the claim paints nothing. It can still get
	 * here: a batched commit fires on a trailing timer, so a run superseded
	 * inside that window reports once more, with a fraction of its own.
	 */
	report(key: RunProgressKey, runId: string | null, value: number | null): void {
		if (!isShown(key, runId)) return;
		send({ state: "running", value });
	},

	/**
	 * `runId` ended badly. The indicator says so - briefly, and only where a
	 * platform has a failed state - and the claim is given up with it, so
	 * nothing this run does afterwards repaints over the flash.
	 */
	fail(key: RunProgressKey, runId: string | null): void {
		if (!isShown(key, runId)) return;
		shownFor = null;
		send({ state: "failed" });
	},

	/** `runId` is over. A run the indicator is not showing is a no-op. */
	clear(key: RunProgressKey, runId: string | null): void {
		if (!isShown(key, runId)) return;
		shownFor = null;
		send({ state: "idle" });
	},
};
