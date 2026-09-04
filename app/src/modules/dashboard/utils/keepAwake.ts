/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which runs are long enough to be worth asking about (issue #1357).
 *
 * The wake lock is off by default: an app that silently overrides the user's
 * power settings is a worse citizen than one that lets a short run finish
 * before the machine idles out. What is left is the case the setting exists
 * for - a run the user starts and walks away from - and that case announces
 * itself in the config, so the app asks then rather than making the user find
 * a preference first.
 */

import type { LoadTestRunConfig } from "@/stores/dashboard-store";

/**
 * A run at least this long is worth an ask.
 *
 * Five minutes because that is under the shortest sleep timer a laptop ships
 * with (macOS idles the display at 2 minutes on battery and suspends a few
 * minutes later; Windows' balanced plan sleeps at 15). A run that cannot
 * outlast any of them is not worth interrupting the user over, and a run that
 * can is exactly the one that comes back with a hole in it.
 */
export const LONG_RUN_SECONDS = 300;

/** Parse the `"600s"` form the run config carries; plain digits too. */
function seconds(value: string | undefined): number | null {
	if (!value) return null;
	const match = /^\s*(\d+)\s*s?\s*$/.exec(value);
	if (!match) return null;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How long the run says it will take, or `null` when it does not say.
 *
 * An iterations run has no duration at all - it ends when the work does - so
 * there is no number here to compare, and nothing to ask about. A ramp run
 * carries its total in `duration`; `rampUpDuration` is the fallback for a
 * config that named only the ramp.
 */
export function runLengthSeconds(config: LoadTestRunConfig | null | undefined): number | null {
	if (!config) return null;
	return seconds(config.duration) ?? seconds(config.rampUpDuration);
}

/** Is this a run the user is likely to walk away from? */
export function isLongRun(config: LoadTestRunConfig | null | undefined): boolean {
	const length = runLengthSeconds(config);
	return length !== null && length >= LONG_RUN_SECONDS;
}

/** "30 minutes" / "8 minutes" - the length, for the sentence that asks. */
export function formatRunLength(totalSeconds: number): string {
	if (totalSeconds < 120) return `${totalSeconds} seconds`;
	const minutes = Math.round(totalSeconds / 60);
	if (minutes < 120) return `${minutes} minutes`;
	const hours = Math.round(minutes / 6) / 10;
	return `${hours} hours`;
}
