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
