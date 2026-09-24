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
import { formatDuration } from "./format";

/**
 * "45s", "6m 12s", "1h 4m" - the coarsest pair that still says something.
 *
 * A run interrupted overnight is the case the hours branch exists for, and a
 * reader counting 31,000 seconds is a reader the marker failed. Rounds
 * (rather than truncates) and drops a trailing zero unit ("2h", not "2h 0m")
 * - `formatDuration`'s defaults suit a ticking elapsed-time readout, not a
 * one-line "the machine was gone for" sentence.
 */
export function formatSleepDuration(durationMs: number): string {
	return formatDuration(durationMs, { round: true, omitZeroUnit: true });
}

/** The chart mark's label, and the Events row's sentence. */
export function hostSleepLabel(sleep: HostSleep): string {
	return `Host asleep ${formatSleepDuration(sleep.durationMs)}`;
}
