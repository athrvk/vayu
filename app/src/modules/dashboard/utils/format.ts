/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatFixed } from "@/lib/format-number";

/** Dashboard formatting helpers. */

const pluralRules = new Intl.PluralRules("en-US");

/**
 * Pick the whole sentence for `count`, by `pluralize`'s `Intl.PluralRules` category: for a sentence
 * whose verb (or more) agrees with the count, where swapping the noun alone gives "1 request are
 * removed". Each form is written out so it can be read, and grepped, as a sentence.
 */
export function pickByCount(count: number, forms: { one: string; other: string }): string {
	return forms[pluralRules.select(count) === "one" ? "one" : "other"];
}

/**
 * Pick the singular or plural of a noun for `count` via `Intl.PluralRules`, not a hand-rolled "s"
 * suffix or "(s)" (docs/ux-writing.md's numbers-and-units rule).
 */
export function pluralize(
	count: number,
	singular: string,
	plural: string = `${singular}s`
): string {
	return pluralRules.select(count) === "one" ? singular : plural;
}

/**
 * A count (events, streams) in the reader's locale, `-` for a non-finite value.
 * Counts, not milliseconds: `fmt` elsewhere in the dashboard means latency, and
 * the chart formatter `fmtCount` rounds a series value without grouping.
 */
export function formatCount(value: number, decimals = 0): string {
	if (!Number.isFinite(value)) return "-";
	return value.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

/**
 * A measured rate (events/s) in the reader's locale, by the engine's rule for a run figure
 * (`format_run_figure`, `run_export_view.cpp`), so the card and an exported report spell one rate
 * alike: 2 decimals below 10, none above, and a positive rate too small for 2 decimals reads
 * `<0.01`, never a zero it did not measure. `-` for a non-finite value.
 */
export function formatRate(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (value > 0 && value < 0.01) return `<${formatCount(0.01, 2)}`;
	return formatCount(value, Math.abs(value) < 10 ? 2 : 0);
}

export interface FormatDurationOptions {
	/**
	 * Round each component to the nearest unit instead of truncating: a stopwatch someone reads
	 * (how long the host was asleep) should not floor 6m 12s to 6m 11s, while an elapsed-time
	 * counter ticking every second should, so it never seems to skip a second.
	 */
	round?: boolean;
	/**
	 * Drop a trailing unit that comes out to zero ("2h", not "2h 0m"), for a one-line prose
	 * sentence; a fixed-width readout wants both units every time.
	 */
	omitZeroUnit?: boolean;
}

/**
 * A millisecond duration as a compact string ("45s", "6m 12s", "1h 4m"), for prose and labels. See
 * `formatSleepDuration` in `hostSleep.ts` for the "round + omit a zero unit" case a sentence like
 * "Host asleep 2h" wants, and `formatClock` for a ticking counter's fixed-width MM:SS.
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

/**
 * A millisecond duration as a fixed-width "MM:SS" stopwatch. Seconds truncate, so a sub-second
 * counter never skips ahead, and minutes do not roll into hours ("75:00"), the width a header slot
 * is sized for. A negative duration reads as zero.
 */
export function formatClock(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * An error rate in percent as digits, never `0.0` for a rate above zero: one that rounds to nothing
 * at `digits` reads `<0.1` (or `<0.01`), so the number and the colour it is drawn in cannot
 * disagree about whether errors happened. Zero stays `0.0`, the one neutral value.
 */
export function formatErrorPercent(percent: number, digits = 1): string {
	const fixed = formatFixed(percent, digits);
	// The raw rounded figure, not the locale string: "0,1" does not parse back.
	if (percent <= 0 || Math.round(percent * 10 ** digits) > 0) return fixed;
	return `<${formatFixed(10 ** -digits, digits)}`;
}
