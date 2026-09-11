/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Run } from "@/types";

export interface RunDayGroup {
	label: string;
	runs: Run[];
}

/**
 * A calendar-day label for `ms` relative to `now` - "Today", "Yesterday", or
 * a date. This replaced the per-row relative timestamp ("8h ago" repeated
 * down a page of same-day runs said nothing after the first row); it says
 * once, above the day's rows, what every row used to say on its own.
 *
 * A calendar date rather than "N days ago" for anything older: the latter
 * decays on every render (today's "6 days ago" is tomorrow's "7 days ago"),
 * so a run's group would drift out from under it between renders with no
 * event that changed it. Top history UIs (Postman, Hoppscotch) group the
 * same way for the same reason.
 */
function dayLabel(ms: number, now: Date): string {
	if (!ms) return "Unknown date";
	const date = new Date(ms);
	const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

/**
 * Buckets `runs` into consecutive same-day groups, in the order they arrive.
 *
 * Consecutive rather than a full group-then-sort pass: `runs` is already in
 * whatever order `filterRuns`'s Newest/Oldest sort produced, and grouping
 * adjacent same-day runs preserves that order for free - a full bucket pass
 * would have to re-sort groups against the same `sortBy` the caller already
 * applied, a second copy of a decision made once upstream.
 */
export function groupRunsByDay(runs: Run[], now: Date = new Date()): RunDayGroup[] {
	const groups: RunDayGroup[] = [];
	let currentLabel: string | null = null;
	for (const run of runs) {
		const label = dayLabel(run.startTime, now);
		if (label !== currentLabel) {
			groups.push({ label, runs: [] });
			currentLabel = label;
		}
		groups[groups.length - 1].runs.push(run);
	}
	return groups;
}
