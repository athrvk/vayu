/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Created once: building an Intl.NumberFormat is far costlier than calling one,
// and these run per chart tooltip row and per table cell.
const LESS_THAN_TEN = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

function isMissing(num: number | undefined | null): num is undefined | null {
	return num === undefined || num === null || !Number.isFinite(num);
}

/** Two decimals below 10 and whole numbers from there up; trailing zeros drop. */
function formatMagnitude(num: number | undefined | null): string {
	if (isMissing(num)) return "0";
	return (Math.abs(num) < 10 ? LESS_THAN_TEN : WHOLE).format(num);
}

/**
 * Format number with thousand separators
 */
export function formatNumber(num: number | undefined | null): string {
	if (num === undefined || num === null || isNaN(num)) return "0";
	return num.toLocaleString();
}

/** Below this a latency is real but would round to "0" at two decimals. */
const LATENCY_FLOOR_MS = 0.01;

/**
 * A duration in milliseconds as digits, no unit: 2.2749 -> "2.27", 1234 ->
 * "1,234". The caller draws the unit, so a value reads the same in a stat card
 * (unit in its own slot), a table cell and a chart tooltip. A measured value
 * under 0.01 prints as "<0.01" because "0" would claim the request took no
 * time (#2243); only an exact 0 prints as "0".
 */
export function formatMs(ms: number | undefined | null): string {
	if (!isMissing(ms) && ms > 0 && ms < LATENCY_FLOOR_MS) return "<0.01"; // keep in step with LATENCY_FLOOR_MS
	return formatMagnitude(ms);
}

/** A latency split for a surface that draws its unit in a slot of its own. */
export interface LatencyParts {
	value: string;
	unit: "ms" | "s";
}

/**
 * A duration in milliseconds as digits and unit: `formatMs` digits and "ms" up
 * to 999, then seconds with two decimals once it rounds to 1000 ms (1234 ->
 * "1.23", "s"); a missing value is "0", "ms". Stat tiles render the two halves
 * in separate elements, so the unit must come from here and never be written
 * beside the number.
 */
export function formatLatencyParts(ms: number | undefined | null): LatencyParts {
	if (!isMissing(ms) && Math.round(ms) >= 1000)
		return { value: (ms / 1000).toFixed(2), unit: "s" };
	return { value: formatMs(ms), unit: "ms" };
}

/**
 * A duration in milliseconds with its unit ("999ms", "1.23s"); a missing value
 * reads "0ms" (`fmtMs` draws "-" for it). The rule behind every chart tooltip
 * and any surface that has no slot of its own for a unit.
 */
export function formatLatency(ms: number | undefined | null): string {
	const { value, unit } = formatLatencyParts(ms);
	return `${value}${unit}`;
}

/** From here a duration in seconds reads as grouped whole seconds, not "1.25s". */
const WHOLE_SECONDS_FROM = 60;

/**
 * A duration in seconds with its unit: under a minute it is `formatLatency`
 * (0.4 -> "400ms", 4.2 -> "4.20s"), so a clock and a latency never print the
 * same span two ways; from a minute up whole seconds, grouped (75 -> "75s",
 * 3600 -> "3,600s"). A missing value reads as `formatLatency` does, "0ms".
 */
export function formatSeconds(seconds: number | undefined | null): string {
	if (!isMissing(seconds) && seconds >= WHOLE_SECONDS_FROM) return `${WHOLE.format(seconds)}s`;
	return formatLatency(isMissing(seconds) ? null : seconds * 1000);
}

/** A per-second rate as digits, no unit, by the same digits rule as `formatMs`. */
export function formatRate(perSecond: number | undefined | null): string {
	return formatMagnitude(perSecond);
}

/** A byte rate split for a surface that draws its unit in a slot of its own. */
export interface ByteRateParts {
	value: string;
	unit: "KB/s" | "MB/s";
}

/**
 * 0.1 MB/s. Below it two decimals of MB/s keep one significant digit or none:
 * a steady 4.4 KB/s read "0" or "0.01" by the tick pair (#2860).
 */
const MEGABYTE_RATE_FROM = 100_000;

/**
 * A rate in bytes per second as `formatRate` digits and a decimal unit (1 KB is
 * 1000 bytes; `formatBytes` in settings is 1024-based and a different
 * question): KB/s below 0.1 MB/s, MB/s from there (4400 -> "4.4", "KB/s";
 * 2500000 -> "2.5", "MB/s"). A missing value is "0", "KB/s".
 */
export function formatByteRateParts(bytesPerSecond: number | undefined | null): ByteRateParts {
	if (isMissing(bytesPerSecond)) return { value: "0", unit: "KB/s" };
	if (Math.abs(bytesPerSecond) >= MEGABYTE_RATE_FROM)
		return { value: formatMagnitude(bytesPerSecond / 1e6), unit: "MB/s" };
	return { value: formatMagnitude(bytesPerSecond / 1e3), unit: "KB/s" };
}

/** A percentage (0-100) as digits with one decimal, no sign: 99.95 -> "100.0". */
export function formatPercent(percent: number | undefined | null): string {
	return formatOneDecimal(percent);
}

/** A count that is a mean, as digits with one decimal: 4.2 -> "4.2", 10 -> "10.0". */
export function formatOneDecimal(value: number | undefined | null): string {
	if (isMissing(value)) return "0.0";
	return ONE_DECIMAL.format(value);
}
