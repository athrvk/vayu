/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialog's server-monitoring block: what the user types, when it is
 * unusable, and what payload it builds.
 *
 * Kept component-free so the rules can be tested without rendering, exactly as
 * the budgets beside it are. The bounds mirror `engine/src/core/monitor.cpp`.
 * They are a courtesy, not the gate: the engine rejects an unusable block with
 * a 400 whatever this file thinks, and these exist so the user is told before
 * the run rather than after it fails to start.
 */

import type { RunMonitorConfig } from "@/types";

export const MONITOR_INTERVAL_MS = { MIN: 250, MAX: 60_000, DEFAULT: 1000 } as const;
export const MONITOR_MAX_SERIES = 8;

/** What the user has typed. `url` blank means "monitor nothing". */
export interface MonitorDraft {
	url: string;
	intervalMs: number;
	format: "prometheus" | "json";
	/** Metric names, one per line - the shape a `/metrics` body is read in. */
	series: string;
}

export function emptyMonitorDraft(): MonitorDraft {
	return {
		url: "",
		intervalMs: MONITOR_INTERVAL_MS.DEFAULT,
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
 * The reason the engine would reject this block, phrased for the dialog.
 *
 * A blank URL is always fine - monitoring is opt-in, and clearing the field is
 * how a user turns it off. Once a URL is there the rest must hold, and it is
 * said out loud rather than dropped: a run started with a monitor the client
 * quietly discarded is a chart the user waits the whole run for and never gets.
 */
export function monitorError(draft: MonitorDraft): string | null {
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
	if (series.length > MONITOR_MAX_SERIES) {
		return `At most ${MONITOR_MAX_SERIES} metrics can be charted; you named ${series.length}.`;
	}
	return null;
}

/**
 * The `monitor` payload for `POST /runs`, or `undefined` when no endpoint was
 * given - never a block with an empty `series`, which the engine rejects.
 *
 * Assumes {@link monitorError} passed.
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
