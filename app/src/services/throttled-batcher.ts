/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A leading-edge-plus-trailing-timer batcher for a live SSE stream.
 *
 * `LoadTestService` and `ScenarioRunService` both read a stream the renderer
 * cannot commit per event, and both answered it the same way: buffer, commit
 * the first item at once - the first tick or step of a run is the one a reader
 * is waiting on, and holding it back makes a fast run look slow to start - and
 * let a trailing timer carry whatever arrives inside the window. Since #1153
 * that was two field-for-field copies of one mechanism, which is the shape a
 * timing fix or a teardown leak lands in one of and not the other.
 *
 * It owns the buffer, the timer and the cadence, and nothing else. What a batch
 * commits to, when a stream is torn down, and whatever else rides the same
 * flush stay with the caller, whose lifecycles genuinely differ: one has a
 * `stopMonitoring` and a second buffer riding this flush, the other drains on
 * error as well as on close.
 */

import { useClientSettingsStore } from "@/stores";
import { METRICS_UI_THROTTLE_MS } from "@/config/metrics";

export interface ThrottledBatcher<T> {
	/** Buffer an item, committing now or on the trailing timer. */
	push(item: T): void;
	/** Commit whatever is buffered; a no-op when nothing is. */
	flush(): void;
	/** Drop the buffer and its pending commit, for items nothing will show. */
	discard(): void;
}

/**
 * @param commit Receives each batch. Never called with an empty array, and
 * never called re-entrantly from `push` for an item it is not carrying.
 */
export function createThrottledBatcher<T>(commit: (batch: T[]) => void): ThrottledBatcher<T> {
	let pending: T[] = [];
	let lastCommitTime = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const flush = (): void => {
		if (pending.length === 0) return;
		clearTimer();
		lastCommitTime = Date.now();
		const batch = pending;
		pending = [];
		commit(batch);
	};

	return {
		push(item: T): void {
			pending.push(item);
			// Read per push, not once: a live change to the setting takes effect
			// on the next event rather than on the next run.
			const throttleMs =
				useClientSettingsStore.getState().liveRefreshMs || METRICS_UI_THROTTLE_MS;
			const elapsed = Date.now() - lastCommitTime;
			if (elapsed >= throttleMs || lastCommitTime === 0) {
				flush();
			} else if (timer === null) {
				timer = setTimeout(() => {
					timer = null;
					flush();
				}, throttleMs - elapsed);
			}
		},
		flush,
		discard(): void {
			clearTimer();
			pending = [];
			// Back to the leading edge: the next item belongs to a list nothing
			// has seen yet, so it commits at once the way a run's first does.
			lastCommitTime = 0;
		},
	};
}
