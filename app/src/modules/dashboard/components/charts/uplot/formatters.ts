/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Shared value/axis formatters for the centralized charts. */

export const fmtMs = (v: number | null | undefined): string =>
	v == null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`;

export const axisMs = (v: number): string =>
	v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`;

export const fmtRate = (v: number | null | undefined): string =>
	v == null ? "-" : `${v.toFixed(0)}/s`;

export const axisRate = (v: number): string =>
	v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;

export const fmtCount = (v: number | null | undefined): string =>
	v == null ? "-" : `${Math.round(v)}`;

export const fmtPct = (v: number | null | undefined): string =>
	v == null ? "-" : `${v.toFixed(1)}%`;

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
