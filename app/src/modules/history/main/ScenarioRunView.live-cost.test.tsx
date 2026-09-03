/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a live run costs the run tab per commit (issue #1153).
 *
 * The correctness of the list is `ScenarioRunView.test.tsx`'s subject. This
 * file pins the two properties that keep a fast run's list affordable, both of
 * which are invisible to a test that only reads the rendered output:
 *
 * - the cards are memoized, and the list hands them props that hold their
 *   identity, so a re-render of the tab is not a re-render of every mounted
 *   card. A memo whose props are rebuilt per render is not a memo, which is why
 *   the handler identity is asserted and not just the `memo` wrapper;
 * - the header's four counts and its two whole-list questions come from the
 *   summary the store folded as the rows arrived, not from a scan of the rows
 *   per render. That is asserted by driving the store and reading the header,
 *   because a summary nothing displays is this repo's most repeated defect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ScenarioStepCardProps } from "./components/ScenarioStepCard";
import type { Run, RunReport, ScenarioStepEvent, StepOutcome } from "@/types";

const reportQuery = { data: undefined as RunReport | undefined, isLoading: false };
vi.mock("@/queries", () => ({ useRunReportQuery: () => reportQuery }));
vi.mock("@/services/api", () => ({ apiService: { stopRun: vi.fn() } }));

/**
 * Every set of props the list handed a card, in render order.
 *
 * The real card is rendered underneath, so the tree is the real one; what this
 * wrapper adds is a record of what the list passed down. The wrapper itself is
 * deliberately *not* memoized - the question here is what the parent builds,
 * and a memo on the recorder would hide exactly that.
 */
const handedDown: ScenarioStepCardProps[] = [];
vi.mock("./components/ScenarioStepCard", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./components/ScenarioStepCard")>();
	const Real = actual.default;
	return {
		...actual,
		default: (props: ScenarioStepCardProps) => {
			handedDown.push(props);
			return <Real {...props} />;
		},
	};
});

import ScenarioRunView from "./ScenarioRunView";
import { useScenarioRunStore } from "@/stores";
import { emptyStepSummary } from "./scenario-steps";

const RUN: Run = { id: "run-1", type: "scenario", status: "running", startTime: 1, endTime: 0 };

function event(
	stepIndex: number,
	outcome: StepOutcome = "passed",
	extra: Partial<ScenarioStepEvent> = {}
): ScenarioStepEvent {
	return {
		iteration: 0,
		stepIndex,
		name: `Step ${stepIndex + 1}`,
		outcome,
		statusCode: 200,
		latencyMs: 10,
		...extra,
	};
}

/** A report `results[]` row, for the changeover a run's end makes. */
function storedStep(stepIndex: number, outcome: StepOutcome) {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: 200,
		latencyMs: 5,
		trace: {
			iteration: 0,
			stepIndex,
			stepName: `Step ${stepIndex + 1}`,
			outcome,
			response: { headers: {}, body: "{}" },
		},
	};
}

function report(results: ReturnType<typeof storedStep>[]): RunReport {
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
		results,
	};
}

/** The step names on screen, in the order the list renders them. */
function shownNames(): string[] {
	return screen
		.queryAllByRole("button", { expanded: false })
		.map((row) => (row.textContent ?? "").match(/Step \d+/)?.[0] ?? "");
}

function stream(steps: ScenarioStepEvent[]): void {
	act(() => {
		useScenarioRunStore.getState().addSteps(steps);
	});
}

beforeEach(() => {
	handedDown.length = 0;
	reportQuery.data = undefined;
	useScenarioRunStore.setState({
		runId: null,
		steps: [],
		summary: emptyStepSummary(),
		isStreaming: false,
		error: null,
	});
	act(() => {
		useScenarioRunStore.getState().startRun("run-1");
	});
});

describe("what a live run costs the list", () => {
	it("is a memoized card, so an unchanged row can bail out of a re-render", async () => {
		// Past the recorder this file mocks in, to the component the app
		// actually renders. The exported value, not a scan of the file: a `memo`
		// the source mentions but does not export is not one React applies.
		const real = await vi.importActual<typeof import("./components/ScenarioStepCard")>(
			"./components/ScenarioStepCard"
		);

		expect((real.default as unknown as { $$typeof: symbol }).$$typeof).toBe(
			Symbol.for("react.memo")
		);
	});

	it("hands every card the same toggle handler across a re-render", () => {
		render(<ScenarioRunView run={RUN} />);
		stream([event(0), event(1), event(2)]);

		const firstPass = [...handedDown];
		expect(firstPass.length).toBeGreaterThanOrEqual(3);
		// One handler for the whole list, not one per row.
		expect(new Set(firstPass.map((p) => p.onToggle)).size).toBe(1);

		handedDown.length = 0;
		// A re-render of the tab that changes nothing about the rows. Reverting
		// the stable handler makes this a different function every time, and
		// every mounted card re-renders on every keystroke.
		fireEvent.change(screen.getByLabelText(/search steps by name/i), {
			target: { value: "Step" },
		});

		expect(handedDown.length).toBeGreaterThan(0);
		expect(handedDown[0].onToggle).toBe(firstPass[0].onToggle);
	});

	it("keeps a row's props identical when a later step arrives", () => {
		render(<ScenarioRunView run={RUN} />);
		stream([event(0)]);
		const before = handedDown.find((p) => p.step.stepIndex === 0);

		handedDown.length = 0;
		stream([event(1)]);
		const after = handedDown.find((p) => p.step.stepIndex === 0);

		// Same row object and same handler, which is what lets the memo bail the
		// untouched card out while the new one mounts.
		expect(after?.step).toBe(before?.step);
		expect(after?.onToggle).toBe(before?.onToggle);
	});

	it("reads the four counts from the folded summary rather than a scan of the rows", () => {
		render(<ScenarioRunView run={RUN} />);
		stream([event(0, "passed"), event(1, "failed"), event(2, "skipped"), event(3, "errored")]);

		// The chips are the summary's only reader on the live path; a count the
		// store folded and nothing showed would be the defect this asserts away.
		for (const outcome of ["passed", "failed", "skipped", "errored"] as const) {
			const chip = document.querySelector(`[data-outcome-count="${outcome}"]`);
			expect(chip?.textContent).toBe(`1 ${outcome}`);
		}
	});

	/*
	 * Issue #1205. The rows a chip or the search box matched are kept across
	 * commits and extended with the batch that arrived, so what the list shows
	 * is no longer read off the whole run per flush. `useFilteredSteps.test.tsx`
	 * proves the equivalence and the cost; this is the wiring - that the view
	 * asks it for the rows and the total, and that a batch landing under an
	 * active filter reaches the screen.
	 */
	it("shows what a filter matches, batch after batch", () => {
		render(<ScenarioRunView run={RUN} />);
		stream([event(0, "passed"), event(1, "failed")]);
		fireEvent.click(screen.getByLabelText(/show only failed steps/i));
		expect(shownNames()).toEqual(["Step 2"]);

		// The batch, not the run: only its failed row joins the list.
		stream([event(2, "passed"), event(3, "failed")]);
		expect(shownNames()).toEqual(["Step 2", "Step 4"]);

		// And a replay that revises a row already on screen throws the kept rows
		// away rather than showing one the list no longer holds.
		stream([event(1, "passed")]);
		expect(shownNames()).toEqual(["Step 4"]);
	});

	it("matches the stored rows over again when they replace the live ones", () => {
		const { rerender } = render(<ScenarioRunView run={RUN} />);
		stream([event(0, "passed"), event(1, "failed")]);
		fireEvent.click(screen.getByLabelText(/show only failed steps/i));
		expect(shownNames()).toEqual(["Step 2"]);

		/*
		 * The run ends and its report lands, so the view reads the stored rows
		 * instead: a longer list of different objects under the same controls.
		 * The mutation this pins is the view handing the hook the live epoch for
		 * that list too - it has not moved, so the rows matched from the live
		 * list would be kept and only the third row tested, showing "Step 2",
		 * which the stored rows say passed.
		 */
		reportQuery.data = report([
			storedStep(0, "failed"),
			storedStep(1, "passed"),
			storedStep(2, "failed"),
		]);
		rerender(<ScenarioRunView run={RUN} />);

		expect(shownNames()).toEqual(["Step 1", "Step 3"]);
	});

	it("says the list is empty because of the chip, not because the run is", () => {
		render(<ScenarioRunView run={RUN} />);
		stream([event(0, "passed")]);
		fireEvent.click(screen.getByLabelText(/show only failed steps/i));

		// The narrowed-to-nothing empty state, which reads the same total the
		// rows do - not the run's own emptiness, which has its own wording.
		expect(screen.getByText(/no failed steps in the stored rows/i)).toBeTruthy();
	});

	it("reads the two whole-list questions from the summary too", () => {
		render(<ScenarioRunView run={RUN} />);
		// A first pass with no data binding: neither question is answered yes,
		// so no row says which iteration it belongs to.
		stream([event(0)]);
		expect(screen.queryByText(/iteration 1/i)).toBeNull();

		// A second pass, bound to a data row: both flip, and the rows say so.
		stream([event(0, "passed", { iteration: 1, dataRowIndex: 2 })]);
		expect(screen.getByText(/iteration 2/i)).toBeTruthy();
	});
});
