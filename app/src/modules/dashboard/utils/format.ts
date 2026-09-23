/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Dashboard formatting helpers.
 */

/** Format a millisecond duration as a compact human-readable string. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

const pluralRules = new Intl.PluralRules("en-US");

/**
 * Real plural handling for a counted noun, per the UX writing guide - never a
 * hand-rolled "noun(s)" ternary. Only "one" and "other" matter for en-US.
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return pluralRules.select(count) === "one" ? singular : plural;
}
