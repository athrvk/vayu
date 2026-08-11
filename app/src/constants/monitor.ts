/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Server-monitoring bounds, mirroring `constants::monitor` engine-side.
 *
 * The interval **bounds** are fixed on both sides - they exist to stop a
 * cadence that measures the scraper rather than the target. `DEFAULT` and
 * `MONITOR_MAX_SERIES` are only the pre-config seeds: the live values come from
 * the `monitorIntervalMs` / `monitorMaxSeries` engine settings via
 * {@link useMonitorSettings}, and these stand in until that query resolves.
 */
export const MONITOR_INTERVAL_MS = { MIN: 250, MAX: 60_000, DEFAULT: 1000 } as const;

/** Seed for `monitorMaxSeries`; the engine rejects a longer list with a 400. */
export const MONITOR_MAX_SERIES = 8;
