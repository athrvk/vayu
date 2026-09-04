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

interface HoldState {
	/** What `holdWakeLock` resolved with, or `null` while that call is in flight. */
	token: string | null;
	/**
	 * `release()` ran before `token` arrived. Honored the moment the promise
	 * settles, so a run shorter than the IPC round trip does not leak a lock it
	 * already asked to drop.
	 */
	releasePending: boolean;
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

		const state: HoldState = { token: null, releasePending: false };
		// Recorded before the round trip: a second `hold()` on this key, called
		// before this one answers, must see it as already in flight.
		holds.set(key, state);

		api.holdWakeLock(reason)
			.then((token) => {
				if (!state.releasePending) {
					state.token = token;
					return;
				}
				// Released while still in flight - the token is only good for
				// handing straight back, never for staying live.
				holds.delete(key);
				void api
					.releaseWakeLock(token)
					.catch((error: unknown) => warnFailure(key, "late release", error));
			})
			.catch((error: unknown) => {
				warnFailure(key, "hold", error);
				// No token ever arrived, so there is nothing to release later - drop
				// the entry rather than leaving the key wedged against a lock that
				// will never come.
				holds.delete(key);
			});
	},

	/** Hand the lock under `key` back. A key that is not held is a no-op. */
	release(key: WakeLockKey): void {
		const state = holds.get(key);
		if (!state) return;

		if (state.token === null) {
			// Still waiting on `holdWakeLock` - mark it and let the `.then` above
			// release the token the moment it arrives.
			state.releasePending = true;
			return;
		}

		holds.delete(key);
		const api = bridge();
		if (!api) return;
		void api
			.releaseWakeLock(state.token)
			.catch((error: unknown) => warnFailure(key, "release", error));
	},
};
