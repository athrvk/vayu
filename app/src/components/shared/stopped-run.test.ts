/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `stoppedRunOf` decides whether the budgets card qualifies its verdict, and
 * with what. The cases that matter: a run that was not stopped gets nothing,
 * and every way the duration or the elapsed time can be missing degrades to a
 * smaller claim instead of an invented number.
 */

import { describe, it, expect } from "vitest";
import { stoppedRunOf } from "./stopped-run";
import type { RunReport } from "@/types/domain";

type Subject = Pick<RunReport, "metadata" | "summary">;

function report(
	over: {
		status?: string;
		duration?: string;
		startTime?: number;
		endTime?: number;
		totalDurationSeconds?: number;
	} = {}
): Subject {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: over.status ?? "stopped",
			startTime: over.startTime ?? 1_000,
			endTime: over.endTime ?? 4_000,
			configuration: over.duration === undefined ? {} : { duration: over.duration },
		},
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: over.totalDurationSeconds ?? 3,
			avgRps: 1,
		},
	} as Subject;
}

describe("stoppedRunOf", () => {
	it("is absent for every status but stopped", () => {
		// Mutation check: ignoring `status` returns a value for these.
		for (const status of ["completed", "failed", "running", "pending"]) {
			expect(stoppedRunOf(report({ status, duration: "20s" }))).toBeUndefined();
		}
	});

	it("is absent for a report with no metadata", () => {
		expect(stoppedRunOf({ metadata: undefined, summary: report().summary })).toBeUndefined();
	});

	it("reads the planned duration in seconds from a suffixed duration", () => {
		// Mutation check: ignoring the configured duration leaves
		// `plannedSeconds` undefined.
		expect(stoppedRunOf(report({ duration: "20s" }))).toEqual({
			elapsedSeconds: 3,
			plannedSeconds: 20,
		});
	});

	it("reads minutes and a bare number", () => {
		expect(stoppedRunOf(report({ duration: "1m" }))?.plannedSeconds).toBe(60);
		expect(stoppedRunOf(report({ duration: "45" }))?.plannedSeconds).toBe(45);
	});

	it("leaves the plan out when the run declared no duration or an unreadable one", () => {
		expect(stoppedRunOf(report())?.plannedSeconds).toBeUndefined();
		expect(stoppedRunOf(report({ duration: "soon" }))?.plannedSeconds).toBeUndefined();
	});

	it("prefers the summary's duration to the start and end stamps", () => {
		const subject = report({ totalDurationSeconds: 3, startTime: 0, endTime: 60_000 });
		expect(stoppedRunOf(subject)?.elapsedSeconds).toBe(3);
	});

	it("falls back to the start and end stamps when the summary has no duration", () => {
		const subject = report({ totalDurationSeconds: 0, startTime: 1_000, endTime: 8_500 });
		expect(stoppedRunOf(subject)?.elapsedSeconds).toBe(7.5);
	});

	it("reports no elapsed time when neither source is usable", () => {
		expect(
			stoppedRunOf(report({ totalDurationSeconds: 0, startTime: 1_000, endTime: 0 }))
				?.elapsedSeconds
		).toBeUndefined();
		expect(
			stoppedRunOf(report({ totalDurationSeconds: 0, startTime: 5_000, endTime: 1_000 }))
				?.elapsedSeconds
		).toBeUndefined();
	});
});
