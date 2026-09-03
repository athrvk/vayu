/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * The filtered step list, kept across a live run's commits (issue #1205).
 *
 * Two things have to hold and neither is visible from the rendered output:
 * that it answers exactly what a from-scratch `filterSteps` answers for the
 * same rows and the same controls, and that it gets there without running the
 * predicate over rows it has already tested. The first is proved by
 * equivalence over a randomized stream of appends, replays and filter changes
 * - the shape `detectAnomalies.test.ts` uses for the same class of problem -
 * and the second by counting the work the keeping exists to avoid.
 *
 * The rows and the epoch come from `foldStepEvents` rather than being built by
 * hand, because what the hook is trusting is precisely what that fold reports.
 */

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFilteredSteps } from "./useFilteredSteps";
import {
	filterSteps,
	foldStepEvents,
	emptyStepSummary,
	type ScenarioStepRow,
	type StepFold,
	type StepListFilter,
} from "./scenario-steps";
import type { ScenarioStepEvent, StepOutcome } from "@/types";

const NAMES = ["GET /health", "POST /checkout", "GET /cart", "POST /login"];
const OUTCOMES: StepOutcome[] = ["passed", "failed", "skipped", "errored"];

function event(
	iteration: number,
	stepIndex: number,
	outcome: StepOutcome = "passed",
	name = NAMES[stepIndex % NAMES.length]
): ScenarioStepEvent {
	return { iteration, stepIndex, name, outcome, statusCode: 200, latencyMs: 5 };
}

/** A live list, folded exactly as the store folds it. */
class Stream {
	fold: StepFold = { steps: [], summary: emptyStepSummary() };
	epoch = 1;

	commit(events: readonly ScenarioStepEvent[]): void {
		const { fold, appendedOnly } = foldStepEvents(this.fold, events);
		this.fold = fold;
		if (!appendedOnly) this.epoch += 1;
	}

	get steps(): ScenarioStepRow[] {
		return this.fold.steps;
	}
}

const ALL = 1_000_000;

/**
 * Every render of the hook, driven the way the view drives it: the rows and
 * the epoch of the moment, and whatever the two controls say.
 */
function driveHook(stream: Stream, filter: StepListFilter) {
	return renderHook(
		({
			steps,
			epoch,
			filter: f,
		}: {
			steps: ScenarioStepRow[];
			epoch: number;
			filter: StepListFilter;
		}) => useFilteredSteps(steps, f, epoch),
		{ initialProps: { steps: stream.steps, epoch: stream.epoch, filter } }
	);
}

/** Seeded, so a failure names one reproducible sequence rather than "sometimes". */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("useFilteredSteps against a from-scratch filter", () => {
	it("answers what filterSteps answers, over a randomized run", () => {
		const random = mulberry32(20261205);
		const stream = new Stream();
		let filter: StepListFilter = { outcome: null, query: "" };
		const view = driveHook(stream, filter);

		let appends = 0;
		let replays = 0;
		let narrowings = 0;
		let step = 0;

		for (let round = 0; round < 220; round += 1) {
			const roll = random();
			if (roll < 0.6) {
				// A batch of new steps, the ordinary case.
				const size = 1 + Math.floor(random() * 6);
				const batch: ScenarioStepEvent[] = [];
				for (let i = 0; i < size; i += 1, step += 1) {
					batch.push(
						event(
							Math.floor(step / NAMES.length),
							step % NAMES.length,
							OUTCOMES[Math.floor(random() * OUTCOMES.length)]
						)
					);
				}
				stream.commit(batch);
				appends += 1;
			} else if (roll < 0.8 && stream.steps.length > 0) {
				// A reconnect's replay, landing on a row already held and
				// changing it - the case that must throw the kept rows away.
				const at = Math.floor(random() * stream.steps.length);
				const row = stream.steps[at];
				stream.commit([
					event(
						row.iteration,
						row.stepIndex,
						OUTCOMES[Math.floor(random() * OUTCOMES.length)],
						row.name
					),
				]);
				replays += 1;
			} else {
				// A chip pressed, a search typed, or both cleared.
				filter = {
					outcome: random() < 0.5 ? OUTCOMES[Math.floor(random() * 4)] : null,
					query:
						random() < 0.5
							? NAMES[Math.floor(random() * NAMES.length)].slice(0, 6)
							: "",
				};
				narrowings += 1;
			}

			view.rerender({ steps: stream.steps, epoch: stream.epoch, filter });

			const oracle = filterSteps(stream.steps, filter);
			expect(view.result.current.total).toBe(oracle.length);
			expect(view.result.current.take(ALL)).toEqual([...oracle]);
			// The window is a prefix of the same list, in the same order.
			expect(view.result.current.take(7)).toEqual([...oracle].slice(0, 7));
		}

		// The sequence has to have exercised all three, or the equivalence above
		// is a statement about appends alone.
		expect(appends).toBeGreaterThan(20);
		expect(replays).toBeGreaterThan(10);
		expect(narrowings).toBeGreaterThan(10);
		expect(stream.steps.length).toBeGreaterThan(200);
	});

	it("rebuilds when a filter is cleared and pressed again", () => {
		const stream = new Stream();
		stream.commit([event(0, 0, "failed"), event(0, 1, "passed")]);
		const failed: StepListFilter = { outcome: "failed", query: "" };
		const view = driveHook(stream, failed);
		expect(view.result.current.total).toBe(1);

		view.rerender({
			steps: stream.steps,
			epoch: stream.epoch,
			filter: { outcome: null, query: "" },
		});
		stream.commit([event(0, 2, "failed")]);
		view.rerender({ steps: stream.steps, epoch: stream.epoch, filter: failed });

		// Two failed rows, not one kept from before the filter was cleared plus
		// whatever arrived while it was off.
		expect(view.result.current.total).toBe(2);
		expect(view.result.current.take(ALL)).toEqual([...filterSteps(stream.steps, failed)]);
	});

	it("hands the list itself back when neither control narrows", () => {
		const stream = new Stream();
		stream.commit([event(0, 0), event(0, 1)]);
		const view = driveHook(stream, { outcome: null, query: "" });

		expect(view.result.current.total).toBe(2);
		expect(view.result.current.take(ALL)).toEqual(stream.steps);
	});

	it("starts over when the list it was reading is replaced", () => {
		const stream = new Stream();
		stream.commit([event(0, 0, "failed"), event(0, 1, "failed")]);
		const filter: StepListFilter = { outcome: "failed", query: "" };
		const view = driveHook(stream, filter);
		expect(view.result.current.total).toBe(2);

		/*
		 * What `startRun` does, and what the changeover to the report's stored
		 * rows does: a different list under the same controls. It is longer than
		 * the one that was read, so the mutation this pins - trusting the rows
		 * already matched and filtering only what is past them - would answer
		 * three (two failed rows carried over from a list that is gone, plus the
		 * one at the end) where the list on screen holds one.
		 */
		const second = new Stream();
		second.epoch = stream.epoch + 1;
		second.commit([event(0, 0, "passed"), event(0, 1, "passed"), event(0, 2, "failed")]);
		view.rerender({ steps: second.steps, epoch: second.epoch, filter });

		expect(view.result.current.total).toBe(1);
		expect(view.result.current.take(ALL)).toEqual([...filterSteps(second.steps, filter)]);
	});
});

/**
 * Count the per-row half of the predicate. A search lowercases each step's
 * name (`matchesQuery`), so calls to `toLowerCase` are one per row tested plus
 * one per pass for the query itself - which is exactly the work that used to be
 * paid over the whole run on every batch that arrived.
 */
function measure<T>(fn: () => T): { result: T; rowsTested: number } {
	const real = String.prototype.toLowerCase;
	let calls = 0;
	String.prototype.toLowerCase = function (this: string) {
		calls += 1;
		return real.call(this);
	};
	try {
		const result = fn();
		return { result, rowsTested: calls };
	} finally {
		String.prototype.toLowerCase = real;
	}
}

describe("what a commit costs a filtered list", () => {
	it("tests the batch that arrived, not the run so far", () => {
		const stream = new Stream();
		const filter: StepListFilter = { outcome: null, query: "checkout" };
		for (let step = 0; step < 2_000; step += 1) {
			stream.commit([event(Math.floor(step / NAMES.length), step % NAMES.length)]);
		}

		const view = driveHook(stream, filter);
		const before = view.result.current.total;

		const batch = 20;
		for (let i = 0; i < batch; i += 1) {
			// Named so they match: the count below is the whole point.
			stream.commit([event(500 + i, 0, "passed", "POST /checkout")]);
		}

		const flush = measure(() =>
			view.rerender({ steps: stream.steps, epoch: stream.epoch, filter })
		);
		const scratch = measure(() => filterSteps(stream.steps, filter));

		/*
		 * The mutation this pins: re-filtering the whole list per commit. The
		 * bound is the batch plus the query's own lowercasing and a little
		 * slack; a from-scratch pass over the same list is two orders of
		 * magnitude above it, which is the assertion below rather than a number
		 * that would have to be maintained.
		 */
		expect(flush.rowsTested).toBeLessThanOrEqual(batch + 5);
		expect(scratch.rowsTested).toBeGreaterThan(stream.steps.length);
		expect(view.result.current.total).toBe(before + batch);
		expect(view.result.current.take(ALL)).toEqual([...filterSteps(stream.steps, filter)]);
	});

	it("copies the window it was asked for, not the whole match", () => {
		const stream = new Stream();
		for (let step = 0; step < 1_200; step += 1) {
			stream.commit([event(Math.floor(step / NAMES.length), step % NAMES.length, "failed")]);
		}
		const view = driveHook(stream, { outcome: "failed", query: "" });

		expect(view.result.current.total).toBe(1_200);
		expect(view.result.current.take(200)).toHaveLength(200);
		// A fresh array each time, so nothing downstream holds a list that
		// changes under it.
		expect(view.result.current.take(200)).not.toBe(view.result.current.take(200));
	});
});
