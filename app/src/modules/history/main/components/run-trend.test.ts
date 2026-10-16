/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which runs a request's trend is drawn from, and in what order (#2165).
 * Mutation checks: drop the newest run (`slice(1)` before the cut) and the
 * ordering and point-count cases go red; widen the status filter to include a
 * running row and the filter case goes red.
 */

import { describe, it, expect } from "vitest";
import type { LoadResultSummary, Run } from "@/types";
import { RUN_TREND_LIMIT, buildRunTrend } from "./run-trend";

function loadRun(
	id: string,
	startTime: number,
	summary: LoadResultSummary | undefined,
	status: Run["status"] = "completed"
): Run {
	return { id, type: "load", status, startTime, endTime: startTime + 1, resultSummary: summary };
}

describe("buildRunTrend", () => {
	it("returns one point per run with a summary, oldest first, from a newest-first list", () => {
		const runs = [
			loadRun("c", 3000, { rps: 30, p95Ms: 300, errorRate: 3 }),
			loadRun("b", 2000, { rps: 20, p95Ms: 200, errorRate: 2 }),
			loadRun("a", 1000, { rps: 10, p95Ms: 100, errorRate: 1 }),
		];

		const points = buildRunTrend(runs, "b");

		expect(points.map((p) => p.startTime)).toEqual([1000, 2000, 3000]);
		expect(points.map((p) => p.p95Ms)).toEqual([100, 200, 300]);
		expect(points.map((p) => p.rps)).toEqual([10, 20, 30]);
		expect(points.map((p) => p.errorRate)).toEqual([1, 2, 3]);
		expect(points.map((p) => p.isOpen)).toEqual([false, true, false]);
	});

	it("keeps a missing key as null, never zero", () => {
		const [point] = buildRunTrend([loadRun("a", 1, { rps: 5 })], "x");

		expect(point.rps).toBe(5);
		expect(point.p95Ms).toBeNull();
		expect(point.errorRate).toBeNull();
	});

	it("keeps a real zero error rate", () => {
		const [point] = buildRunTrend([loadRun("a", 1, { errorRate: 0 })], "x");

		expect(point.errorRate).toBe(0);
	});

	it("includes stopped and failed runs and flags the stopped ones", () => {
		const runs = [
			loadRun("c", 3, { rps: 1 }, "failed"),
			loadRun("b", 2, { rps: 1 }, "stopped"),
			loadRun("a", 1, { rps: 1 }, "completed"),
		];

		expect(buildRunTrend(runs, "x").map((p) => p.stopped)).toEqual([false, true, false]);
	});

	it("leaves out rows with no summary, a running status and non-load runs", () => {
		const runs: Run[] = [
			loadRun("running", 5, undefined, "running"),
			loadRun("running-with-summary", 4, { rps: 1 }, "running"),
			loadRun("pending", 3, undefined, "pending"),
			{ id: "d", type: "design", status: "completed", startTime: 2, endTime: 3 },
			loadRun("ok", 1, { rps: 1 }),
		];

		expect(buildRunTrend(runs, "x")).toHaveLength(1);
	});

	it("keeps the newest runs when the list is longer than the limit", () => {
		const runs = Array.from({ length: RUN_TREND_LIMIT + 5 }, (_, i) =>
			loadRun(`r${i}`, (RUN_TREND_LIMIT + 5 - i) * 1000, { rps: i })
		);

		const points = buildRunTrend(runs, "x");

		expect(points).toHaveLength(RUN_TREND_LIMIT);
		expect(points[points.length - 1].rps).toBe(0);
		expect(points[0].rps).toBe(RUN_TREND_LIMIT - 1);
	});
});
