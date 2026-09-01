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
