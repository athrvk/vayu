/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatDayHeading } from "@/lib/time-value";
import type { Run } from "@/types";

export interface RunDayGroup {
	label: string;
	runs: Run[];
}

/**
 * A calendar-day label for `ms` relative to `now`: "Today", "Yesterday", or a date. Said once above
 * the day's rows, it replaces a per-row "8h ago" repeated on every row of the day.
 *
 * A date rather than "N days ago" for anything older: that decays on every render (today's "6 days
 * ago" is tomorrow's "7 days ago"), so a run's group would drift out from under it with no event
 * that changed it. Postman and Hoppscotch group history the same way.
 */
function dayLabel(ms: number, now: Date): string {
	if (!ms) return "Unknown date";
	const date = new Date(ms);
	const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	return formatDayHeading(date, now);
}

/**
 * Buckets `runs` into consecutive same-day groups, in arrival order. Consecutive, not
 * group-then-sort: `runs` is already in `filterRuns`'s Newest/Oldest order, which grouping adjacent
 * rows keeps for free, while a full bucket pass would re-sort groups against the same `sortBy`, a
 * second copy of a decision made upstream.
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
