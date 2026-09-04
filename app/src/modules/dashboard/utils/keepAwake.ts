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
 * Ten minutes, and the number is a judgement rather than a measurement: the
 * app cannot read the machine's sleep timer. No Electron API reports it, the
 * value differs per power source, and even the true number would not answer
 * the question - the timer counts from the user's last input, not from the
 * run's start, so the same run suspends or does not depending on when its
 * owner walked away.
 *
 * So this is a proxy for "a run the user is likely to leave", placed among the
 * timers it wants to sit under: Windows' balanced plan sleeps at 15 minutes on
 * battery, GNOME at 20, and a MacBook on battery goes within a few minutes of
 * idle. Ten covers the first two and gives up on the third, which nothing short
 * of asking about almost every run could catch.
 *
 * The costs either side are not symmetric - a needless ask costs one click, a
 * missing one costs the run - so when this moves, it should move down.
 */
export const LONG_RUN_SECONDS = 600;

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
