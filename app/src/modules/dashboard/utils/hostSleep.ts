/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How a host sleep reads, in one place (issue #1357).
 *
 * The charts mark it and History's Events tab states it, the same way one
 * `detectAnomalies` call feeds both the bands and the prose - so the mark on
 * the chart and the row under it can never disagree about how long the machine
 * was gone.
 */

import type { HostSleep } from "@/stores/host-sleep-store";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * "45s", "6m 12s", "1h 4m" - the coarsest pair that still says something.
 *
 * A run interrupted overnight is the case the hours branch exists for, and a
 * reader counting 31,000 seconds is a reader the marker failed.
 */
export function formatSleepDuration(durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < MINUTE_MS) return `${Math.round(ms / SECOND_MS)}s`;
	if (ms < HOUR_MS) {
		const minutes = Math.floor(ms / MINUTE_MS);
		const seconds = Math.round((ms % MINUTE_MS) / SECOND_MS);
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(ms / HOUR_MS);
	const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS);
	return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** The chart mark's label, and the Events row's sentence. */
export function hostSleepLabel(sleep: HostSleep): string {
	return `Host asleep ${formatSleepDuration(sleep.durationMs)}`;
}
