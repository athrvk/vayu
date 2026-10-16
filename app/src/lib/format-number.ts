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

/**
 * A duration in milliseconds as digits, no unit: 2.2749 -> "2.27", 1234 ->
 * "1,234". The caller draws the unit, so a value reads the same in a stat card
 * (unit in its own slot), a table cell and a chart tooltip. How a value under
 * 0.01 prints is #2147's call; here it rounds like any other.
 */
export function formatMs(ms: number | undefined | null): string {
	return formatMagnitude(ms);
}

/** A per-second rate as digits, no unit, by the same digits rule as `formatMs`. */
export function formatRate(perSecond: number | undefined | null): string {
	return formatMagnitude(perSecond);
}

/** A percentage (0-100) as digits with one decimal, no sign: 99.95 -> "100.0". */
export function formatPercent(percent: number | undefined | null): string {
	if (isMissing(percent)) return "0.0";
	return ONE_DECIMAL.format(percent);
}
