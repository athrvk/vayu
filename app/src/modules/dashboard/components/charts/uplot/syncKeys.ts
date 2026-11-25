/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cursor-sync group keys: charts sharing a key move one cursor together, showing the same instant
 * on all of them. Defined once so the live group and the history group stay consistent across the
 * files rendering them (MetricsView, HistoricalChartsSection, PerformanceTab). Only same-x-axis
 * (time) charts belong in a group; the concurrency scatter and the percentile-distribution plot
 * have other x axes and stay unsynced on purpose.
 */
export const CHART_SYNC = {
	live: "live-charts",
	history: "history-charts",
} as const;
