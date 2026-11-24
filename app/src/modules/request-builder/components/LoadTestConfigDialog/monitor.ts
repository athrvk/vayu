/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The server-monitoring block: what the user types, when it is unusable, and the payload it builds.
 * Component-free like the budgets, to test without rendering. The bounds mirror
 * `engine/src/core/monitor.cpp` as a courtesy, not the gate: the engine 400s an unusable block
 * regardless, and these tell the user before the run, not after it fails to start.
 */

import type { RunMonitorConfig } from "@/types";
import { MONITOR_INTERVAL_MS, MONITOR_MAX_SERIES } from "@/constants/monitor";

/** What the user has typed. `url` blank means "monitor nothing". */
export interface MonitorDraft {
	url: string;
	intervalMs: number;
	format: "prometheus" | "json";
	/** Metric names, one per line - the shape a `/metrics` body is read in. */
	series: string;
}

/**
 * A blank draft. @p intervalMs is the configured default (`monitorIntervalMs`), passed in to keep
 * this pure: the dialog resolves it from engine config, and the seed stands in until then.
 */
export function emptyMonitorDraft(intervalMs: number = MONITOR_INTERVAL_MS.DEFAULT): MonitorDraft {
	return {
		url: "",
		intervalMs,
		format: "prometheus",
		series: "",
	};
}

/** The typed metric names, blanks and surrounding whitespace removed. */
export function monitorSeriesList(draft: MonitorDraft): string[] {
	return draft.series
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/**
 * Why the engine would reject this block, phrased for the dialog. A blank URL is fine: monitoring
 * is opt-in, and clearing the field turns it off. With a URL the rest must hold, and a fault is
 * said, not dropped: a monitor the client quietly discarded is a chart the user waits a whole run
 * for and never gets.
 */
export function monitorError(draft: MonitorDraft, maxSeries = MONITOR_MAX_SERIES): string | null {
	const url = draft.url.trim();
	if (url === "") return null;

	if (!/^https?:\/\//i.test(url)) {
		return "The monitoring endpoint must be an http:// or https:// URL.";
	}
	if (
		!Number.isFinite(draft.intervalMs) ||
		draft.intervalMs < MONITOR_INTERVAL_MS.MIN ||
		draft.intervalMs > MONITOR_INTERVAL_MS.MAX
	) {
		return `The scrape interval must be between ${MONITOR_INTERVAL_MS.MIN} and ${MONITOR_INTERVAL_MS.MAX}ms.`;
	}
	const series = monitorSeriesList(draft);
	if (series.length === 0) {
		return "Name at least one metric to read from the endpoint, one per line.";
	}
	if (series.length > maxSeries) {
		return `At most ${maxSeries} metrics can be charted; you named ${series.length}. Raise "Server monitoring metric limit" in Settings to chart more.`;
	}
	const unmatchable = draft.format === "prometheus" && series.find(isNotAPrometheusName);
	if (unmatchable) {
		return `"${unmatchable}" is not a metric name. Series are matched by name and every label set is summed, so write the name without a {…} label filter or spaces.`;
	}
	return null;
}

/**
 * The engine's Prometheus series rule (`read_monitor_series` in `engine/src/core/monitor.cpp`): the
 * parser reads a name up to its first `{` or whitespace, so a name holding either never matches
 * (#3120). A JSON key may hold both; the rule is the Prometheus format's.
 */
function isNotAPrometheusName(name: string): boolean {
	return /[{ \t\r\n\f\v]/.test(name);
}

/**
 * The `monitor` payload for `POST /runs`, or `undefined` without an endpoint, never an empty
 * `series`, which the engine refuses. Assumes {@link monitorError} passed.
 */
export function buildMonitor(draft: MonitorDraft): RunMonitorConfig | undefined {
	const url = draft.url.trim();
	if (url === "") return undefined;
	const series = monitorSeriesList(draft);
	if (series.length === 0) return undefined;
	return {
		url,
		intervalMs: draft.intervalMs,
		format: draft.format,
		series,
	};
}
