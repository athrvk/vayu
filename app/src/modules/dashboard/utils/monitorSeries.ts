/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Joining scraped server vitals onto the run's own timeline.
 *
 * The two series are sampled by different clocks: ticks land on the engine's
 * cadence (100ms live, 1s persisted) and monitor samples on whatever scrape
 * interval the user chose, which may be slower, faster, or drifting against it.
 * `uPlot.AlignedData` has one shared x column, so a chart that draws both needs
 * the vitals resampled onto the ticks' x axis - that resampling is here, pure
 * and unit-tested, rather than inside a chart component.
 */

import type { LoadTestMetrics, MonitorSample } from "@/types";

/** Vitals resampled onto a run's tick timeline, ready for `uPlot.AlignedData`. */
export interface JoinedMonitorSeries {
	/** Elapsed seconds, one entry per tick - the shared x column. */
	times: number[];
	/** Series names, in the order `columns` holds them. */
	names: string[];
	/** One column per name; `null` where no reading covers that tick. */
	columns: (number | null)[][];
}

const EMPTY: JoinedMonitorSeries = { times: [], names: [], columns: [] };

/**
 * How long a reading is allowed to stand in for later ticks, derived from the
 * scrape cadence the samples actually show.
 *
 * A gauge read every 5s must still draw across the four 1s ticks after it, or
 * the line would be four fifths holes. But a reading must not be held across a
 * scrape that *failed*: that would draw a flat line over an outage, which is
 * the one thing the overlay exists to make visible. So the window is a small
 * multiple of the observed median spacing - long enough to bridge the cadence,
 * short enough that a missed scrape shows as a gap.
 */
export function stalenessWindowMs(samples: MonitorSample[]): number {
	const FLOOR_MS = 2000;
	if (samples.length < 2) return FLOOR_MS;
	const gaps: number[] = [];
	for (let i = 1; i < samples.length; i++) {
		gaps.push(samples[i].timestamp - samples[i - 1].timestamp);
	}
	gaps.sort((a, b) => a - b);
	const median = gaps[Math.floor(gaps.length / 2)];
	return Math.max(FLOOR_MS, Math.round(median * 2.5));
}

/** Every series name the samples carry, sorted so column order is stable. */
export function monitorSeriesNames(samples: MonitorSample[]): string[] {
	const names = new Set<string>();
	for (const sample of samples) {
		for (const name of Object.keys(sample.series ?? {})) names.add(name);
	}
	return [...names].sort();
}

/**
 * Resample @p samples onto @p history's tick timeline.
 *
 * Each tick takes the newest reading at or before it (a gauge holds its value
 * until the next scrape - interpolating between two readings would invent
 * numbers the target never reported), or `null` when the newest reading is
 * older than {@link stalenessWindowMs} - which is what makes a failed scrape
 * read as a gap rather than a plateau. Ticks before the first scrape are `null`
 * for the same reason.
 *
 * Both inputs are time-ordered by their producers; the samples are sorted
 * defensively because they arrive from two sources (live SSE frames and a
 * paginated history fetch).
 */
export function joinMonitorToTimeline(
	history: LoadTestMetrics[],
	samples: MonitorSample[]
): JoinedMonitorSeries {
	if (history.length === 0 || samples.length === 0) return EMPTY;

	const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
	const names = monitorSeriesNames(ordered);
	if (names.length === 0) return EMPTY;

	const maxAgeMs = stalenessWindowMs(ordered);
	const times: number[] = [];
	const columns: (number | null)[][] = names.map(() => []);

	// Two pointers over two ascending series - the join is linear, not a scan
	// per tick, because a long run pairs thousands of ticks with thousands of
	// samples on every render.
	let cursor = -1;
	for (const tick of history) {
		while (cursor + 1 < ordered.length && ordered[cursor + 1].timestamp <= tick.timestamp) {
			cursor++;
		}
		times.push(tick.elapsed_seconds);
		const current = cursor >= 0 ? ordered[cursor] : null;
		const fresh = current !== null && tick.timestamp - current.timestamp <= maxAgeMs;
		names.forEach((name, i) => {
			const value = fresh ? current.series?.[name] : undefined;
			columns[i].push(typeof value === "number" ? value : null);
		});
	}

	return { times, names, columns };
}
