/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One keyed wake-lock holder, shared by every run service (issue #1357).
 *
 * `electron/power-save.ts` (main process) ref-counts holds by token; this is
 * the renderer side of that contract, kept in one place so a load run and a
 * collection run each hold under their own key instead of two services
 * copying the same token bookkeeping - the repo rule against a hand-rolled
 * copy of a primitive: it never receives the primitive's fixes.
 *
 * `hold`/`release` are fire-and-forget by design - neither returns a promise,
 * because a run's start and stop paths must not await IPC to do work of their
 * own. The round trip to the main process happens in the background and is
 * reconciled here, including the case where `release` runs before the
 * matching `hold` has even heard back.
 */

/** The two runs that ever hold a lock at once. */
export const WAKE_LOCK_KEYS = {
	loadRun: "load-run",
	collectionRun: "collection-run",
} as const;

export type WakeLockKey = (typeof WAKE_LOCK_KEYS)[keyof typeof WAKE_LOCK_KEYS];

/**
 * One hold, tracked by the object rather than by its key.
 *
 * The distinction is load-bearing: `release()` frees the key immediately, so a
 * hold that is still in flight when its run ends is reconciled through the
 * object its own round trip closed over. Keeping the released hold under the
 * key instead would swallow the next `hold()` on that key as a duplicate - and
 * `LoadTestService.startMonitoring` releases and re-holds in the same tick when
 * one run replaces another, which is exactly that case.
 */
interface HoldState {
	/** What `holdWakeLock` resolved with, or `null` while that call is in flight. */
	token: string | null;
	/** The run let go. The token is handed back on arrival if it is not here yet. */
	released: boolean;
}

const holds = new Map<WakeLockKey, HoldState>();

type Bridge = NonNullable<Window["electronAPI"]>;

/**
 * The preload bridge, or nothing outside Electron - the same guard the rest of
 * the renderer uses for an Electron-only method. Resolved once per call and
 * used from there on, so a key can never be recorded as held against a bridge
 * that turned out not to exist.
 */
function bridge(): Bridge | undefined {
	if (typeof window === "undefined") return undefined;
	const api = window.electronAPI;
	return api?.holdWakeLock ? api : undefined;
}

function warnFailure(key: WakeLockKey, what: string, error: unknown): void {
	console.warn(`[wake-lock] ${what} for "${key}" failed`, error);
}

/** Hand one token back. A failure here is logged, never thrown at a run. */
function releaseToken(api: Bridge, key: WakeLockKey, token: string): void {
	void api.releaseWakeLock(token).catch((error: unknown) => warnFailure(key, "release", error));
}

export const wakeLock = {
	/**
	 * Ask the OS to stay awake under `key`. A key that is already held (or
	 * being acquired) is a no-op - `startMonitoring` can be called again for
	 * the same run without taking a second lock.
	 */
	hold(key: WakeLockKey, reason: string): void {
		const api = bridge();
		if (!api) return;
		if (holds.has(key)) return;

		const state: HoldState = { token: null, released: false };
		// Recorded before the round trip: a second `hold()` on this key, called
		// before this one answers, must see it as already in flight.
		holds.set(key, state);

		api.holdWakeLock(reason)
			.then((token) => {
				state.token = token;
				// Released while still in flight - the token is only good for
				// handing straight back, never for staying live.
				if (state.released) releaseToken(api, key, token);
			})
			.catch((error: unknown) => {
				warnFailure(key, "hold", error);
				// No token ever arrived, so there is nothing to release later - drop
				// the entry rather than leaving the key wedged against a lock that
				// will never come. Only if it is still this hold's: a `release` and a
				// fresh `hold` may already have replaced it.
				if (holds.get(key) === state) holds.delete(key);
			});
	},

	/** Hand the lock under `key` back. A key that is not held is a no-op. */
	release(key: WakeLockKey): void {
		const state = holds.get(key);
		if (!state) return;

		// Free the key first, whatever stage the hold is at, so the next run can
		// take a lock of its own in this same tick.
		holds.delete(key);
		state.released = true;
		if (state.token === null) return;

		const api = bridge();
		if (api) releaseToken(api, key, state.token);
	},
};
