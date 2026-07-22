/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cursor-sync group keys. Charts that share a key move one cursor together, so
 * hovering any of them shows the same instant on all the others. Defined once so
 * the live-dashboard group and the history group stay consistent across the
 * separate files that render them (MetricsView, HistoricalChartsSection,
 * PerformanceTab).
 *
 * Only same-x-axis (time) charts belong in a group - the concurrency scatter and
 * the percentile-distribution plot have different x axes and are deliberately
 * left unsynced.
 */
export const CHART_SYNC = {
	live: "live-charts",
	history: "history-charts",
} as const;
