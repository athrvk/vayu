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
 * reddens it. The three that matter most are the replay case (the SSE ring
 * replays on reconnect, so an append-only list doubles rows), the outcome
 * counts (folding `skipped` into `passed` is the false-pass this summary exists
 * to prevent), and the batch fold's summary, which is checked against a fresh
 * count of the rows it produced rather than against itself.
 */

import { describe, it, expect } from "vitest";
import {
	emptyStepListReason,
	emptyStepSummary,
	foldStepEvents,
	filterSteps,
	outcomeCountsFromReport,
	stepKey,
	stepRowsFromReport,
	summarizeSteps,
	tallyTests,
	thinningDisclosure,
	type ScenarioStepRow,
	type StepFold,
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
		const steps = append([], event(0, 0, "passed", { validation: { ...verdict } }));
		expect(steps[0].validation).toEqual(verdict);
	});

	it("is absent for a step of an unbound collection", () => {
		// Absent, never `{checked: false}`: a response nobody judged against a
		// contract did not fail to be judged by one.
		expect(append([], event(0, 0))[0].validation).toBeUndefined();
	});
});

/**
 * One event at a time, which is how most of the placement cases below read
 * best. The summary is thrown away here - {@link foldStepEvents}'s own block
 * covers it - so only the rows are under test.
 */
function append(steps: ScenarioStepRow[], event: ScenarioStepEvent): ScenarioStepRow[] {
	return foldStepEvents({ steps, summary: emptyStepSummary() }, [event]).fold.steps;
}

describe("foldStepEvents, one event at a time", () => {
	it("appends steps in the order they arrive", () => {
		let steps: ScenarioStepRow[] = [];
		steps = append(steps, event(0, 0));
		steps = append(steps, event(0, 1));

		expect(steps.map(stepKey)).toEqual(["0:0", "0:1"]);
	});

	it("does not duplicate a row when the stream replays an event", () => {
		let steps: ScenarioStepRow[] = [];
		steps = append(steps, event(0, 0));
		steps = append(steps, event(0, 1));

		// What a reconnect does: Last-Event-ID replays from the last id the
		// browser saw, so events already rendered arrive a second time.
		steps = append(steps, event(0, 0));
		steps = append(steps, event(0, 1));

		expect(steps).toHaveLength(2);
		expect(steps.map(stepKey)).toEqual(["0:0", "0:1"]);
	});

	it("returns the same array when a replayed event changes nothing", () => {
		const first = append([], event(0, 0));
		const again = append(first, event(0, 0));

		expect(again).toBe(first);
	});

	it("keeps plan order when an event arrives out of order after a gap", () => {
		let steps: ScenarioStepRow[] = [];
		steps = append(steps, event(1, 0));
		steps = append(steps, event(0, 2));
		steps = append(steps, event(0, 0));

		expect(steps.map(stepKey)).toEqual(["0:0", "0:2", "1:0"]);
	});

	it("keys on (iteration, stepIndex), so the same step in two iterations is two rows", () => {
		let steps: ScenarioStepRow[] = [];
		steps = append(steps, event(0, 0));
		steps = append(steps, event(1, 0));

		expect(steps).toHaveLength(2);
	});

	it("replaces a row when the replayed copy differs", () => {
		let steps = append([], event(0, 0, "passed"));
		steps = append(steps, event(0, 0, "failed"));

		expect(steps).toHaveLength(1);
		expect(steps[0].outcome).toBe("failed");
	});

	/*
	 * The placement is a binary search over a list that is sorted by
	 * construction, rather than a sort per event (issue #730). These three are
	 * its edges: the ordinary append, an insertion before everything, and a
	 * replay deep inside - the case a search that only ever looked at the tail
	 * would answer "new row" to, doubling it.
	 */
	describe("placing a row without re-sorting the list", () => {
		const many = (count: number) => {
			let steps: ScenarioStepRow[] = [];
			for (let i = 0; i < count; i += 1) steps = append(steps, event(0, i));
			return steps;
		};

		it("keeps a long run in plan order as it streams", () => {
			const steps = many(200);
			expect(steps.map((s) => s.stepIndex)).toEqual([...Array(200).keys()]);
		});

		it("seats a row that belongs before every one already there", () => {
			let steps = many(50);
			steps = append(steps, event(0, 0, "failed", { name: "resumed" }));

			// Replaced in place, not prepended as a 51st row.
			expect(steps).toHaveLength(50);
			expect(steps[0].name).toBe("resumed");
		});

		it("finds a replay in the middle of a long list rather than doubling it", () => {
			let steps = many(200);
			steps = append(steps, event(0, 97, "failed"));

			expect(steps).toHaveLength(200);
			expect(steps[97].outcome).toBe("failed");
			expect(steps.map((s) => s.stepIndex)).toEqual([...Array(200).keys()]);
		});

		it("inserts an out-of-order arrival mid-list, in its own place", () => {
			let steps: ScenarioStepRow[] = [];
			for (const index of [0, 1, 4, 5]) steps = append(steps, event(0, index));
			steps = append(steps, event(0, 3));

			expect(steps.map(stepKey)).toEqual(["0:0", "0:1", "0:3", "0:4", "0:5"]);
		});
	});
});

/**
 * Issue #1153. The live path commits a batch per flush rather than a row per
 * event, and carries the header's summary with it rather than letting the view
 * recount the list. Both are only worth having if a batch says exactly what the
 * same events said one at a time, and if the summary says exactly what a fresh
 * count of the rows would - so that is what these pin, against
 * {@link summarizeSteps} as an independent oracle rather than against another
 * run of the fold itself.
 */
describe("foldStepEvents, a batch at a time", () => {
	const empty = (): StepFold => ({ steps: [], summary: emptyStepSummary() });
	// The rows and their summary; what the batch disturbed has its own block.
	const fold = (current: StepFold, events: readonly ScenarioStepEvent[]): StepFold =>
		foldStepEvents(current, events).fold;

	it("folds a batch to the same rows the events would one at a time", () => {
		const events = [event(0, 0), event(0, 1), event(1, 0, "failed"), event(1, 1, "skipped")];

		const batched = fold(empty(), events);
		let oneAtATime: ScenarioStepRow[] = [];
		for (const e of events) oneAtATime = append(oneAtATime, e);

		expect(batched.steps).toEqual(oneAtATime);
	});

	it("carries a summary equal to a fresh count of the rows it produced", () => {
		const batch = fold(empty(), [
			event(0, 0, "passed"),
			event(0, 1, "failed"),
			event(0, 2, "skipped"),
			event(0, 3, "errored"),
		]);

		expect(batch.summary).toEqual(summarizeSteps(batch.steps));
	});

	it("keeps the summary right across batches, replays included", () => {
		/*
		 * The mutation this pins: dropping the decrement for a replaced row.
		 * The second batch replays 0:1 with a different outcome, so a fold that
		 * only ever adds would report the run as having both a passed and a
		 * failed copy of one step - two outcomes from one execution, and a
		 * `passed` count the four chips would show that no row supports.
		 */
		const first = fold(empty(), [event(0, 0, "passed"), event(0, 1, "passed")]);
		const second = fold(first, [event(0, 1, "failed"), event(0, 2, "passed")]);

		expect(second.summary).toEqual(summarizeSteps(second.steps));
		expect(second.summary.counts).toEqual({ passed: 2, failed: 1, skipped: 0, errored: 0 });
	});

	it("returns the fold itself when every event in the batch is an idempotent replay", () => {
		const first = fold(empty(), [event(0, 0), event(0, 1)]);
		const again = fold(first, [event(0, 0), event(0, 1)]);

		// Identity, not equality: the store reads this to commit nothing, so a
		// fold that merely matched would still re-render the list on a
		// reconnect's replay.
		expect(again).toBe(first);
		expect(again.steps).toBe(first.steps);
	});

	it("commits the whole batch when only part of it is a replay", () => {
		const first = fold(empty(), [event(0, 0)]);
		const second = fold(first, [event(0, 0), event(0, 1)]);

		expect(second.steps).not.toBe(first.steps);
		expect(second.steps.map(stepKey)).toEqual(["0:0", "0:1"]);
		expect(second.summary).toEqual(summarizeSteps(second.steps));
	});

	it("answers the two whole-list questions the header asks", () => {
		const plain = fold(empty(), [event(0, 0)]);
		expect(plain.summary.iterationSteps).toBe(0);
		expect(plain.summary.dataBoundSteps).toBe(0);

		// A second pass over the plan, and a run bound to a data set: the row
		// says which iteration it belongs to and which row it took.
		const richer = fold(plain, [event(1, 0, "passed", { dataRowIndex: 3 })]);
		expect(richer.summary.iterationSteps).toBe(1);
		expect(richer.summary.dataBoundSteps).toBe(1);
	});

	it("takes a replaced row's data binding back out with it", () => {
		/*
		 * The mutation this pins: latching those two as booleans instead of
		 * counting them. A replay is compared on outcome, status, latency and
		 * name - not on `dataRowIndex` - so a replacement that changes the
		 * outcome and carries no data row is a replace, and a latched flag would
		 * still claim the run bound a data set that no row on screen supports.
		 * Nothing the engine sends does this today; the fold does not need to
		 * assume that.
		 */
		const bound = fold(empty(), [event(0, 0, "passed", { dataRowIndex: 3 })]);
		expect(bound.summary.dataBoundSteps).toBe(1);

		const unbound = fold(bound, [event(0, 0, "failed")]);

		expect(unbound.steps).toHaveLength(1);
		expect(unbound.summary.dataBoundSteps).toBe(0);
		expect(unbound.summary).toEqual(summarizeSteps(unbound.steps));
	});

	it("leaves an empty batch alone", () => {
		const first = fold(empty(), [event(0, 0)]);
		expect(fold(first, [])).toBe(first);
	});
});

/**
 * Issue #1205. A reader holding rows a filter matched needs to know whether the
 * rows below the ones that just arrived are still the rows it matched, and by
 * the time a list reaches them an appended row and a replaced one look alike.
 * The fold is the only place that knows, so it says - and what it says is only
 * useful if it is false for every disturbance, which is what these pin.
 */
describe("what a batch disturbed", () => {
	const empty = (): StepFold => ({ steps: [], summary: emptyStepSummary() });

	it("only appended, for a batch of steps that arrived in plan order", () => {
		expect(foldStepEvents(empty(), [event(0, 0), event(0, 1)]).appendedOnly).toBe(true);
	});

	it("only appended, for a replay that changed nothing", () => {
		const first = foldStepEvents(empty(), [event(0, 0)]).fold;

		// Nothing moved, so nothing a reader holds is stale.
		expect(foldStepEvents(first, [event(0, 0)]).appendedOnly).toBe(true);
	});

	it("did more than append when a replay replaced a row in place", () => {
		const first = foldStepEvents(empty(), [event(0, 0, "passed"), event(0, 1, "passed")]).fold;

		/*
		 * The mutation this pins: reporting an append here. Row 0:0 stopped
		 * being passed, so a view holding the passed rows it had matched would
		 * keep showing one the list no longer has - and would never look at it
		 * again, since only this flag sends it back over the list.
		 */
		expect(foldStepEvents(first, [event(0, 0, "failed")]).appendedOnly).toBe(false);
	});

	it("did more than append when a gap-resume spliced a row mid-list", () => {
		const first = foldStepEvents(empty(), [event(0, 0), event(0, 3)]).fold;

		// Placed between the two, so every row after it moved along one.
		expect(foldStepEvents(first, [event(0, 1)]).appendedOnly).toBe(false);
	});

	it("did more than append when one batch does both", () => {
		const first = foldStepEvents(empty(), [event(0, 0, "passed")]).fold;
		const mixed = foldStepEvents(first, [event(0, 0, "failed"), event(0, 1, "passed")]);

		expect(mixed.fold.steps).toHaveLength(2);
		expect(mixed.appendedOnly).toBe(false);
	});
});

describe("summarizeSteps", () => {
	it("counts skipped separately from passed", () => {
		const steps = [
			{ ...event(0, 0, "passed") },
			{ ...event(0, 1, "skipped") },
			{ ...event(0, 2, "skipped") },
		];

		const counts = summarizeSteps(steps).counts;

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

		expect(summarizeSteps(steps).counts).toEqual({
			passed: 1,
			failed: 1,
			skipped: 1,
			errored: 1,
		});
	});

	it("is all zeros for an empty list", () => {
		expect(summarizeSteps([]).counts).toEqual({ passed: 0, failed: 0, skipped: 0, errored: 0 });
	});
});

/**
 * Issue #726. Counting the stored rows undercounts `passed` on any run that
 * filled `maxScenarioStoredSteps`, because thinning drops passes alone - so the
 * chips read the engine's exact whole-run totals instead, and fall back to the
 * rows only when the report cannot say.
 */
describe("outcomeCountsFromReport", () => {
	it("reads the engine's whole-run totals, not the surviving rows", () => {
		const counts = outcomeCountsFromReport(
			report({
				scenario: {
					iterations: 1,
					iterationsCompleted: 1,
					stepsExecuted: 6_000,
					passed: 5_990,
					failed: 10,
					skipped: 0,
					errored: 0,
					stepsStored: 5_000,
					stepsDropped: 1_000,
				},
			})
		);

		// 5,990, not the 4,990 the 5,000 kept rows would tally.
		expect(counts).toEqual({ passed: 5_990, failed: 10, skipped: 0, errored: 0 });
	});

	it("is null for a report that carries no scenario summary", () => {
		// A live run before its report lands, and a load run's report. Both must
		// leave the caller on the row tally rather than on four zeros.
		expect(outcomeCountsFromReport(report({}))).toBeNull();
		expect(outcomeCountsFromReport(undefined)).toBeNull();
	});

	it("is null when the summary is missing any of the four", () => {
		// An older sidecar's summary types as complete and is not. A partial read
		// would report a real count beside a fabricated zero.
		const partial = report({
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 2,
				passed: 2,
				failed: 0,
				skipped: 0,
				stepsStored: 2,
				stepsDropped: 0,
			} as never,
		});

		expect(outcomeCountsFromReport(partial)).toBeNull();
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

	it("carries the request the step ran, which is the way back to it", () => {
		// The engine has always stamped it and no renderer read it (issue #730):
		// without this the card has nothing to link to, and a failed step is a
		// dead end.
		const rows = stepRowsFromReport(report({ results: [storedStep(0, 2)] }));

		expect(rows[0].requestId).toBe("req_2");
	});

	it("leaves the request absent on a row stored before the runner stamped one", () => {
		const row = storedStep(0, 0);
		delete row.trace!.requestId;

		// Absent rather than "" - the card offers no link at all rather than one
		// that would open nothing.
		expect(stepRowsFromReport(report({ results: [row] }))[0].requestId).toBeUndefined();
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

describe("tallyTests", () => {
	it("counts a stored step's assertion list the way the live frame counts it", () => {
		// The engine sends two numbers live and stores the list; this is where
		// the two meet, so a step must not change its numbers when its stored
		// row arrives.
		expect(
			tallyTests([
				{ name: "status is 200", passed: true },
				{ name: "body names a pet", passed: false, error: "expected undefined" },
				{ name: "took under a second", passed: true },
			])
		).toEqual({ passed: 2, failed: 1 });
	});

	it("says nothing for a step that asserted nothing", () => {
		// Absent, not `{ passed: 0, failed: 0 }` - the chip is not rendered at
		// all for a scriptless step, where "0 tests passed" would read as a
		// result. A run stored before the list existed reads the same way.
		expect(tallyTests([])).toBeUndefined();
		expect(tallyTests(undefined)).toBeUndefined();
	});
});

describe("filterSteps", () => {
	function row(name: string, outcome: StepOutcome, stepIndex: number): ScenarioStepRow {
		return { iteration: 0, stepIndex, name, outcome, statusCode: 200, latencyMs: 1 };
	}

	const steps: ScenarioStepRow[] = [
		row("POST /checkout", "failed", 0),
		row("GET /cart", "passed", 1),
		row("POST /checkout", "passed", 2),
		row("GET /orders", "skipped", 3),
	];

	it("matches a step name case-insensitively, anywhere in it", () => {
		expect(
			filterSteps(steps, { outcome: null, query: "checkout" }).map((s) => s.stepIndex)
		).toEqual([0, 2]);
		expect(
			filterSteps(steps, { outcome: null, query: "CHECKOUT" }).map((s) => s.stepIndex)
		).toEqual([0, 2]);
	});

	it("applies both controls at once, in either order", () => {
		// The useful case the outcome chip cannot answer alone: a run's failures
		// are spread across steps, and this is the one step's.
		const both = filterSteps(steps, { outcome: "failed", query: "checkout" });
		expect(both.map((s) => s.stepIndex)).toEqual([0]);
		// Same predicate whichever the reader reached for first - there is only
		// one, so this pins that there is no order to get wrong.
		expect(
			filterSteps(filterSteps(steps, { outcome: "failed", query: "" }), {
				outcome: null,
				query: "checkout",
			})
		).toEqual(both);
	});

	it("ignores a query that is only whitespace", () => {
		// A field the user cleared to a space is not a filter that matches
		// nothing - it is a field they cleared.
		expect(filterSteps(steps, { outcome: null, query: "   " })).toHaveLength(4);
	});

	it("returns the same array when neither control narrows", () => {
		// An untouched view hands the list on rather than a copy of it: the
		// window is keyed on which list is shown, and the rows below are
		// memoized on their identity, so a copy that only looks new costs a
		// re-render of every card for nothing.
		expect(filterSteps(steps, { outcome: null, query: "" })).toBe(steps);
	});

	it("is empty when a name matches nothing", () => {
		expect(filterSteps(steps, { outcome: null, query: "/refunds" })).toHaveLength(0);
	});
});

describe("emptyStepListReason", () => {
	const thinned = {
		stepsExecuted: 6_000,
		stepsStored: 1,
		stepsDropped: 5_999,
	};

	it("says nothing while no control is narrowing the list", () => {
		// An empty list under no filter is the run's own emptiness, and the
		// view answers that with the run's status instead.
		expect(emptyStepListReason({ outcome: null, query: "" }, null)).toBeNull();
		expect(emptyStepListReason({ outcome: null, query: "  " }, null)).toBeNull();
	});

	it("names the search when the search alone emptied the list", () => {
		const reason = emptyStepListReason({ outcome: null, query: "checkout" }, null);
		expect(reason?.title).toBe('No steps matching "checkout"');
		// What it matched, so a reader whose URL search found nothing knows why.
		expect(reason?.description).toMatch(/step name/i);
		expect(reason?.title).not.toMatch(/passed|failed|skipped|errored/);
	});

	it("names the chip when the chip alone emptied it, and keeps the thinning disclosure", () => {
		const reason = emptyStepListReason({ outcome: "passed", query: "" }, thinned);
		expect(reason?.title).toBe("No passed steps in the stored rows");
		// The chip counts the run and the rows are the store's: without this the
		// "5999 passed" chip above an empty list is a contradiction.
		expect(reason?.description).toMatch(/dropped successes/i);
	});

	it("names both when both are narrowing", () => {
		const reason = emptyStepListReason({ outcome: "failed", query: "checkout" }, null);
		expect(reason?.title).toBe('No failed steps matching "checkout"');
		// Both are named because they are cleared in different places - a reader
		// told only about the chip clears the wrong control.
		expect(reason?.description).toMatch(/failed chip/i);
		expect(reason?.description).toMatch(/search/i);
	});

	it("trims the query it quotes back", () => {
		expect(emptyStepListReason({ outcome: null, query: "  cart " }, null)?.title).toBe(
			'No steps matching "cart"'
		);
	});
});
