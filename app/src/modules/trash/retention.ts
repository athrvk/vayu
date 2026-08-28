/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ConfigEntry } from "@/types";

/** The engine config entry that decides how long the trash keeps a row. */
export const TRASH_RETENTION_KEY = "trashRetentionDays";

/**
 * The retention window, or null when the config has not arrived or cannot be
 * read as a number.
 *
 * Null rather than a fallback to the engine's default of 30: a window is a
 * promise about the user's data, and guessing it is how the app would come to
 * state one the engine is not keeping.
 */
export function retentionDaysFrom(entries: ConfigEntry[] | undefined): number | null {
	const entry = entries?.find((e) => e.key === TRASH_RETENTION_KEY);
	if (!entry) return null;
	const days = Number.parseInt(entry.value, 10);
	return Number.isNaN(days) ? null : days;
}

/**
 * The sentence the Trash view puts under its title.
 *
 * `0` is not "deleted immediately" - it turns the startup purge off, so the
 * trash keeps everything until someone empties it by hand. Getting that
 * backwards would be the worst sentence on the screen.
 */
export function retentionCopy(retentionDays: number | null): string | null {
	if (retentionDays === null) return null;
	if (retentionDays <= 0) return "Items are kept here until you delete them.";
	if (retentionDays === 1) return "Items are deleted for good a day after they land here.";
	return `Items are deleted for good ${retentionDays} days after they land here.`;
}
