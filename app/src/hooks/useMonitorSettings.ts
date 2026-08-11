/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useMonitorSettings
 *
 * The two server-monitoring limits a user can move: the default scrape cadence
 * and how many metrics one run may chart.
 *
 * They live **engine-side** (`monitorIntervalMs` / `monitorMaxSeries`), like
 * the live-chart settings beside them, and for the same reason: the engine
 * applies the cadence to any run that names none and rejects a series list over
 * the cap with a 400. A renderer-local copy could only drift - and it would
 * drift in the two directions that hurt most, a dialog that always sends an
 * explicit interval (so the setting would never apply to a run started here)
 * and one that refuses a metric list the engine would have accepted.
 *
 * Read-only: both are edited from the engine settings list, and this hook is
 * how the load-test dialog seeds and bounds its own fields from them. Until the
 * config query resolves, the module defaults stand - the same numbers the
 * engine seeds, so the gap changes nothing.
 */

import { useConfigQuery } from "@/queries";
import { MONITOR_INTERVAL_MS, MONITOR_MAX_SERIES } from "@/constants/monitor";

export interface MonitorSettings {
	/** Cadence to seed a fresh draft with, in ms. */
	defaultIntervalMs: number;
	/** How many metric names the dialog accepts before it blocks Start. */
	maxSeries: number;
}

export function useMonitorSettings(): MonitorSettings {
	const { data: config } = useConfigQuery();

	const entryValue = (key: string): string | undefined =>
		config?.entries?.find((e) => e.key === key)?.value;

	// Entry values are strings. An absent key - config still loading, or an
	// engine older than these settings - leaves the default rather than parsing
	// `undefined` to NaN.
	const rawInterval = Number(entryValue("monitorIntervalMs"));
	const defaultIntervalMs =
		Number.isFinite(rawInterval) &&
		rawInterval >= MONITOR_INTERVAL_MS.MIN &&
		rawInterval <= MONITOR_INTERVAL_MS.MAX
			? rawInterval
			: MONITOR_INTERVAL_MS.DEFAULT;

	const rawMaxSeries = Number(entryValue("monitorMaxSeries"));
	const maxSeries =
		Number.isFinite(rawMaxSeries) && rawMaxSeries > 0 ? rawMaxSeries : MONITOR_MAX_SERIES;

	return { defaultIntervalMs, maxSeries };
}
