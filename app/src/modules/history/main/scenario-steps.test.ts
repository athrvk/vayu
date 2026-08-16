/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scenario step list, as data. Node-env: none of this needs a DOM.
 *
 * Each block here is mutation-checked - reverting the behaviour it describes
 * reddens it. The two that matter most are the replay case (the SSE ring
 * replays on reconnect, so an append-only list doubles rows) and the outcome
 * counts (folding `skipped` into `passed` is the false-pass this summary exists
 * to prevent).
 */

import { describe, it, expect } from "vitest";
import {
	appendStepEvent,
	countOutcomes,
	stepKey,
	stepRowsFromReport,
	thinningDisclosure,
	type ScenarioStepRow,
} from "./scenario-steps";
import type { RunReport, ScenarioStepEvent, StepOutcome } from "@/types";

function event(
	iteration: number,
	stepIndex: number,
	outcome: StepOutcome = "passed",
	extra: Partial<ScenarioStepEvent> = {}
): ScenarioStepEvent {
	return {
		iteration,
		stepIndex,
		name: `Step ${stepIndex + 1}`,
		outcome,
		statusCode: 200,
		latencyMs: 10,
		...extra,
	};
}

/** A report `results[]` row carrying the step identity the engine stamps. */
function storedStep(
	iteration: number,
	stepIndex: number,
	outcome: StepOutcome = "passed",
	overrides: { name?: string; statusCode?: number; dataRowIndex?: number } = {}
): NonNullable<RunReport["results"]>[number] {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: overrides.statusCode ?? 200,
		latencyMs: 12.5,
		trace: {
			iteration,
			stepIndex,
			dataRowIndex: overrides.dataRowIndex,
			stepName: overrides.name ?? `Step ${stepIndex + 1}`,
			requestId: `req_${stepIndex}`,
			outcome,
			response: { headers: {}, body: "{}" },
		},
	};
}

function report(partial: Partial<RunReport>): RunReport {
	return {
		summary: {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 0,
			avgRps: 0,
		},
		latency: { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		...partial,
	};
}

describe("the live schema verdict", () => {
	it("rides the row it arrived on", () => {
		const verdict = { checked: true, valid: false, failuresTotal: 2 } as const;
		const steps = appendStepEvent([], event(0, 0, "passed", { validation: { ...verdict } }));
		expect(steps[0].validation).toEqual(verdict);
	});

	it("is absent for a step of an unbound collection", () => {
		// Absent, never `{checked: false}`: a response nobody judged against a
		// contract did not fail to be judged by one.
		expect(appendStepEvent([], event(0, 0))[0].validation).toBeUndefined();
	});
});

describe("appendStepEvent", () => {
	it("appends steps in the order they arrive", () => {
		let steps: ScenarioStepRow[] = [];
		steps = appendStepEvent(steps, event(0, 0));
		steps = appendStepEvent(steps, event(0, 1));

		expect(steps.map(stepKey)).toEqual(["0:0", "0:1"]);
	});

	it("does not duplicate a row when the stream replays an event", () => {
		let steps: ScenarioStepRow[] = [];
		steps = appendStepEvent(steps, event(0, 0));
		steps = appendStepEvent(steps, event(0, 1));

		// What a reconnect does: Last-Event-ID replays from the last id the
		// browser saw, so events already rendered arrive a second time.
		steps = appendStepEvent(steps, event(0, 0));
		steps = appendStepEvent(steps, event(0, 1));

		expect(steps).toHaveLength(2);
		expect(steps.map(stepKey)).toEqual(["0:0", "0:1"]);
	});

	it("returns the same array when a replayed event changes nothing", () => {
		const first = appendStepEvent([], event(0, 0));
		const again = appendStepEvent(first, event(0, 0));

		expect(again).toBe(first);
	});

	it("keeps plan order when an event arrives out of order after a gap", () => {
		let steps: ScenarioStepRow[] = [];
		steps = appendStepEvent(steps, event(1, 0));
		steps = appendStepEvent(steps, event(0, 2));
		steps = appendStepEvent(steps, event(0, 0));

		expect(steps.map(stepKey)).toEqual(["0:0", "0:2", "1:0"]);
	});

	it("keys on (iteration, stepIndex), so the same step in two iterations is two rows", () => {
		let steps: ScenarioStepRow[] = [];
		steps = appendStepEvent(steps, event(0, 0));
		steps = appendStepEvent(steps, event(1, 0));

		expect(steps).toHaveLength(2);
	});

	it("replaces a row when the replayed copy differs", () => {
		let steps = appendStepEvent([], event(0, 0, "passed"));
		steps = appendStepEvent(steps, event(0, 0, "failed"));

		expect(steps).toHaveLength(1);
		expect(steps[0].outcome).toBe("failed");
	});
});

describe("countOutcomes", () => {
	it("counts skipped separately from passed", () => {
		const steps = [
			{ ...event(0, 0, "passed") },
			{ ...event(0, 1, "skipped") },
			{ ...event(0, 2, "skipped") },
		];

		const counts = countOutcomes(steps);

		// The mutation this pins: folding `skipped` into `passed` would report
		// 3 passed / 0 skipped, and a step that never ran would read as one that
		// asserted and held.
		expect(counts.passed).toBe(1);
		expect(counts.skipped).toBe(2);
	});

	it("counts all four outcomes independently", () => {
		const steps = [
			{ ...event(0, 0, "passed") },
			{ ...event(0, 1, "failed") },
			{ ...event(0, 2, "skipped") },
			{ ...event(0, 3, "errored") },
		];

		expect(countOutcomes(steps)).toEqual({
			passed: 1,
			failed: 1,
			skipped: 1,
			errored: 1,
		});
	});

	it("is all zeros for an empty list", () => {
		expect(countOutcomes([])).toEqual({ passed: 0, failed: 0, skipped: 0, errored: 0 });
	});
});

describe("stepRowsFromReport", () => {
	it("reads the step identity the engine stamps onto each trace", () => {
		const rows = stepRowsFromReport(
			report({ results: [storedStep(0, 0, "passed", { name: "Log in" })] })
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			iteration: 0,
			stepIndex: 0,
			name: "Log in",
			outcome: "passed",
			statusCode: 200,
		});
		// The stored row travels with the mapped one - it is what the response
		// pane restores from.
		expect(rows[0].result).toBeDefined();
	});

	it("carries the data row an iteration bound, and leaves it absent without one", () => {
		// The wrap is what makes this worth reading back: iteration 2 of a
		// two-row set is row 0 again, and nothing else on the row says so.
		const rows = stepRowsFromReport(
			report({
				results: [storedStep(0, 0, "passed", { dataRowIndex: 0 }), storedStep(1, 0)],
			})
		);

		expect(rows[0].dataRowIndex).toBe(0);
		expect(rows[1].dataRowIndex).toBeUndefined();
	});

	it("sorts stored rows into plan order", () => {
		const rows = stepRowsFromReport(
			report({ results: [storedStep(1, 0), storedStep(0, 1), storedStep(0, 0)] })
		);

		expect(rows.map(stepKey)).toEqual(["0:0", "0:1", "1:0"]);
	});

	it("skips a results row that carries no step identity", () => {
		// A load run's report, or a row written before the runner existed. It is
		// not step 0 of iteration 0, and rendering it as one would invent a step.
		const loadRunRow = {
			timestamp: 1,
			statusCode: 200,
			latencyMs: 1,
			trace: { totalMs: 1 },
		};

		expect(stepRowsFromReport(report({ results: [loadRunRow] }))).toEqual([]);
	});

	it("is empty for a report with no results at all", () => {
		expect(stepRowsFromReport(report({}))).toEqual([]);
		expect(stepRowsFromReport(undefined)).toEqual([]);
	});

	/**
	 * A stored row's schema verdict (issue #681) is deliberately **not** read
	 * here. It reaches the card through `responseFromRunResult` - the same
	 * funnel the response itself comes from - so this file has no second reader
	 * of `trace.validation` to keep in step, and importing that funnel here
	 * would pull the whole response-viewer barrel into the step list's module
	 * graph for one field. `ScenarioStepCard.validation.test.tsx` asserts the
	 * live and stored rows render the same verdict.
	 */
	it("does not re-read the stored verdict onto the row", () => {
		const stored = storedStep(0, 0);
		stored.trace = {
			...stored.trace,
			validation: { checked: true, valid: false, failuresTotal: 1 },
		};

		const rows = stepRowsFromReport(report({ results: [stored] }));
		expect(rows[0].validation).toBeUndefined();
		// The row it *is* read from travels with the mapped row.
		expect(rows[0].result?.trace?.validation).toBeDefined();
	});

	it("does not call an unstamped outcome a pass", () => {
		const rows = stepRowsFromReport(
			report({
				results: [
					{
						timestamp: 1,
						statusCode: 200,
						latencyMs: 1,
						trace: { iteration: 0, stepIndex: 0 },
					},
				],
			})
		);

		expect(rows[0].outcome).not.toBe("passed");
	});
});

describe("thinningDisclosure", () => {
	const scenario = {
		iterations: 1,
		iterationsCompleted: 1,
		stepsExecuted: 10_000,
		passed: 9_990,
		failed: 10,
		skipped: 0,
		errored: 0,
		stepsStored: 5_000,
		stepsDropped: 5_000,
	};

	it("reports what a filled store thinned away", () => {
		expect(thinningDisclosure(report({ scenario }))).toEqual({
			stepsExecuted: 10_000,
			stepsStored: 5_000,
			stepsDropped: 5_000,
		});
	});

	it("says nothing when the run dropped nothing", () => {
		expect(
			thinningDisclosure(
				report({ scenario: { ...scenario, stepsStored: 10_000, stepsDropped: 0 } })
			)
		).toBeNull();
	});

	it("says nothing for a report with no scenario section", () => {
		// A load run, or a run recorded before the section existed. "We cannot
		// tell" must not render as "nothing was dropped".
		expect(thinningDisclosure(report({}))).toBeNull();
		expect(thinningDisclosure(undefined)).toBeNull();
	});
});
