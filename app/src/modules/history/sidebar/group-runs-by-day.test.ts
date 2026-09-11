/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { groupRunsByDay } from "./group-runs-by-day";
import type { Run } from "@/types";

function run(id: string, startTime: number): Run {
	return { id, type: "load", status: "completed", startTime, endTime: startTime } as Run;
}

const now = new Date(2026, 8, 11, 12, 0, 0); // 2026-09-11 noon, local time
const dayMs = 86_400_000;

describe("groupRunsByDay", () => {
	it("labels today's and yesterday's runs, and buckets an older one by date", () => {
		const groups = groupRunsByDay(
			[
				run("today", now.getTime()),
				run("yesterday", now.getTime() - dayMs),
				run("last_week", now.getTime() - 6 * dayMs),
			],
			now
		);

		// The older label's exact text is locale-dependent (a US runtime reads
		// "Sep 5", others "5 Sept") - the same `toLocaleDateString` call is what
		// the source uses, so this compares against the runtime's own answer
		// rather than a literal that only holds under one locale.
		const lastWeekLabel = new Date(now.getTime() - 6 * dayMs).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
		expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", lastWeekLabel]);
		expect(groups.map((g) => g.runs.map((r) => r.id))).toEqual([
			["today"],
			["yesterday"],
			["last_week"],
		]);
	});

	it("merges consecutive same-day runs into one group, in the given order", () => {
		const groups = groupRunsByDay(
			[
				run("today_a", now.getTime()),
				run("today_b", now.getTime() - 60_000),
				run("yesterday", now.getTime() - dayMs),
			],
			now
		);

		expect(groups).toHaveLength(2);
		expect(groups[0].label).toBe("Today");
		expect(groups[0].runs.map((r) => r.id)).toEqual(["today_a", "today_b"]);
		expect(groups[1].label).toBe("Yesterday");
	});

	it("includes the year once a run crosses into a different one", () => {
		const groups = groupRunsByDay([run("last_year", now.getTime() - 300 * dayMs)], now);

		expect(groups[0].label).toMatch(/2025/);
	});

	it("gives an empty list nothing to group", () => {
		expect(groupRunsByDay([], now)).toEqual([]);
	});

	it("labels a run with no recorded start time rather than crashing", () => {
		const groups = groupRunsByDay([run("no_time", 0)], now);
		expect(groups[0].label).toBe("Unknown date");
	});
});
