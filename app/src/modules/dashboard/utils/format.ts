/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Dashboard formatting helpers.
 */

const pluralRules = new Intl.PluralRules("en-US");

/**
 * Pick the singular or plural form of a noun for `count`, via
 * `Intl.PluralRules` rather than a hand-rolled "s" suffix or "(s)" - see
 * docs/ux-writing.md's numbers-and-units rule.
 */
export function pluralize(
	count: number,
	singular: string,
	plural: string = `${singular}s`
): string {
	return pluralRules.select(count) === "one" ? singular : plural;
}

export interface FormatDurationOptions {
	/**
	 * Round each component to the nearest unit instead of truncating. A
	 * stopwatch someone is actually reading (how long the host was asleep)
	 * should not floor 6m 12s down to 6m 11s; an elapsed-time counter that
	 * ticks every second should, so it never appears to skip a second.
	 */
	round?: boolean;
	/**
	 * Drop a trailing unit that comes out to zero ("2h" rather than "2h 0m").
	 * Useful for a one-line prose sentence; a fixed-width readout wants both
	 * units shown every time.
	 */
	omitZeroUnit?: boolean;
}

/**
 * Format a millisecond duration as a compact human-readable string, e.g.
 * "45s", "6m 12s", "1h 4m". The single formatter for every ms-to-duration
 * conversion in the dashboard module - see `formatSleepDuration` in
 * `hostSleep.ts` for the "round + omit a zero unit" case a sentence like
 * "Host asleep 2h" wants.
 */
export function formatDuration(ms: number, options: FormatDurationOptions = {}): string {
	const { round = false, omitZeroUnit = false } = options;
	const clamped = Math.max(0, ms);
	const roundFn = round ? Math.round : Math.floor;
	if (clamped < 1000) return round ? `${roundFn(clamped / 1000)}s` : `${Math.floor(clamped)}ms`;
	const totalSeconds = roundFn(clamped / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		if (seconds === 0 && omitZeroUnit) return `${minutes}m`;
		return `${minutes}m ${seconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (remainingMinutes === 0 && omitZeroUnit) return `${hours}h`;
	return `${hours}h ${remainingMinutes}m`;
}
