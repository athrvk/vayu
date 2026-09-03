/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the live step store publishes about the shape of its own list (#1205).
 *
 * The rows and the summary are `scenario-steps.test.ts`'s subject - the fold is
 * where they are decided, and the store only commits what it is handed. What is
 * decided here is `appendEpoch`: the one thing a reader cannot work out from the
 * list, because every commit hands it a new array whether a row was appended,
 * replaced or spliced in. `useFilteredSteps` keeps the rows a filter matched
 * only while that number holds still, so a number that failed to move would show
 * a reader rows the run no longer has.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useScenarioRunStore } from "./scenario-run-store";
import type { ScenarioStepEvent, StepOutcome } from "@/types";

function event(stepIndex: number, outcome: StepOutcome = "passed"): ScenarioStepEvent {
	return {
		iteration: 0,
		stepIndex,
		name: `Step ${stepIndex + 1}`,
		outcome,
		statusCode: 200,
		latencyMs: 10,
	};
}

const store = () => useScenarioRunStore.getState();

beforeEach(() => {
	useScenarioRunStore.setState({
		runId: null,
		steps: [],
		isStreaming: false,
		error: null,
	});
});

describe("appendEpoch", () => {
	it("holds still while the list only grows at its end", () => {
		store().startRun("run-1");
		const started = store().appendEpoch;

		store().addSteps([event(0), event(1)]);
		store().addSteps([event(2)]);

		expect(store().steps).toHaveLength(3);
		expect(store().appendEpoch).toBe(started);
	});

	it("moves when a replay replaces a row already shown", () => {
		store().startRun("run-1");
		store().addSteps([event(0, "passed"), event(1, "passed")]);
		const before = store().appendEpoch;

		// What a reconnect does: `Last-Event-ID` replays a step whose outcome the
		// run has since revised.
		store().addSteps([event(0, "failed")]);

		expect(store().appendEpoch).toBeGreaterThan(before);
	});

	it("moves when a gap-resume seats a row mid-list", () => {
		store().startRun("run-1");
		store().addSteps([event(0), event(3)]);
		const before = store().appendEpoch;

		store().addSteps([event(1)]);

		expect(store().steps.map((s) => s.stepIndex)).toEqual([0, 1, 3]);
		expect(store().appendEpoch).toBeGreaterThan(before);
	});

	it("holds still for a replay that changes nothing", () => {
		store().startRun("run-1");
		store().addSteps([event(0)]);
		const before = store().appendEpoch;
		const rows = store().steps;

		store().addSteps([event(0)]);

		// The commit itself is skipped, so there is nothing for a reader to redo.
		expect(store().steps).toBe(rows);
		expect(store().appendEpoch).toBe(before);
	});

	it("moves when a second run replaces the first", () => {
		store().startRun("run-1");
		store().addSteps([event(0), event(1)]);
		const before = store().appendEpoch;

		store().startRun("run-2");

		// An emptied list is the sharpest case of "not the list you were
		// reading": without this, the next run's first batches would look like
		// the previous run's list getting longer.
		expect(store().steps).toHaveLength(0);
		expect(store().appendEpoch).toBeGreaterThan(before);
	});
});
