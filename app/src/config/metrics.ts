/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How much live and historical metric data the UI keeps and how often it re-renders, trading chart
 * fidelity for memory and CPU.
 */

/**
 * Live retained metrics are bounded by the user-configurable **time** window (see
 * `constants/live-window.ts`, applied in `dashboard-store.addMetricsBatch`) plus a hard tick cap
 * (`maxRetainedTicks`, default `DEFAULT_MAX_RETAINED_TICKS`), not by a fixed point count.
 */

/** Throttle for committing live SSE metrics into the UI store. */
export const METRICS_UI_THROTTLE_MS = 500;
