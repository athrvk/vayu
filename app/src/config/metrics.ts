/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Metrics Volume Configuration
 *
 * Knobs controlling how much live/historical metric data the UI keeps and
 * how often it re-renders. These trade chart fidelity for memory and CPU.
 */

/** Max historical data points retained in the dashboard store per run. */
export const HISTORICAL_METRICS_CAP = 3000;

/** Throttle for committing live SSE metrics into the UI store. */
export const METRICS_UI_THROTTLE_MS = 500;
