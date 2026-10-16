/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatLatency, formatPercent, formatRate } from "@/lib/format-number";

/** Shared value/axis formatters for the centralized charts. */

export const fmtMs = (v: number | null | undefined): string => (v == null ? "-" : formatLatency(v));

/**
 * Decimals needed to write `step` exactly, up to 4. A tick sequence printed
 * with this many places cannot repeat a label, which a fixed round could: over
 * 0 to 3 ms, `Math.round` read 0.5 / 1 / 1.5 / 2 as "1 1 2 2".
 */
function decimalsFor(step: number): number {
	for (let digits = 0; digits < 4; digits++) {
		const scaled = step * 10 ** digits;
		if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return digits;
	}
	return 4;
}

/** The smallest gap between neighbouring ticks, or the lone tick's own size. */
function tickStep(splits: readonly number[]): number {
	let step = Infinity;
	for (let i = 1; i < splits.length; i++) {
		const gap = Math.abs(splits[i] - splits[i - 1]);
		if (gap > 0) step = Math.min(step, gap);
	}
	return Number.isFinite(step) ? step : Math.abs(splits[0]) || 1;
}

/**
 * A latency axis tick with its unit. uPlot hands the formatter the whole tick
 * array, so the decimals come from the tick spacing rather than each value
 * alone, and the unit from the largest tick: an axis reads either all "ms" or
 * all "s", never "0" beside "1s". Without `splits` the value stands alone.
 */
export const axisMs = (v: number, splits: readonly number[] = [v]): string => {
	const inSeconds = Math.max(...splits.map(Math.abs)) >= 1000;
	const scale = inSeconds ? 1000 : 1;
	const digits = decimalsFor(tickStep(splits) / scale);
	return `${Number((v / scale).toFixed(digits))}${inSeconds ? "s" : "ms"}`;
};

export const fmtRate = (v: number | null | undefined): string =>
	v == null ? "-" : `${formatRate(v)}/s`;

export const axisRate = (v: number): string =>
	v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;

export const fmtCount = (v: number | null | undefined): string =>
	v == null ? "-" : `${Math.round(v)}`;

export const fmtPct = (v: number | null | undefined): string =>
	v == null ? "-" : `${formatPercent(v)}%`;

export const axisPct = (v: number): string => `${Math.round(v)}%`;

export const fmtSeconds = (v: number): string => `${v.toFixed(1)}s`;

/**
 * Server-vitals values, whose unit this app does not know: a run may scrape a
 * CPU fraction (0.42), a byte count (1.4e9) and a queue depth (7) onto the same
 * chart, so the formatter has to stay readable across all three rather than
 * assume one. Large values are abbreviated, small ones keep the precision that
 * is the whole signal.
 */
export const fmtVitals = (v: number | null | undefined): string => {
	if (v == null) return "-";
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
	if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
	if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
	if (abs >= 10) return v.toFixed(1);
	return v.toFixed(3);
};

export const axisVitals = (v: number): string => {
	const abs = Math.abs(v);
	if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
	if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
	if (abs >= 10) return `${Math.round(v)}`;
	return `${v.toFixed(2)}`;
};
