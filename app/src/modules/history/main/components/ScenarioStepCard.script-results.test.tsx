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
 * A step's assertions in the collection-run step list (issue #724).
 *
 * The run computed them for every step and then kept only a one-line summary,
 * so the same request showed a full Tests list on a single Send and nothing at
 * all inside a run. What is pinned here is that both halves of the delivery
 * arrive: the itemized list from the stored trace, rendered by the *same*
 * component the response pane's Tests tab uses, and the tally a live step shows
 * before its stored row exists.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import TestResults from "@/modules/request-builder/components/ResponseViewer/TestResults";
import type { TestResult } from "@/types";
import type { ScenarioStepRow } from "../scenario-steps";

afterEach(cleanup);

const RESULTS: TestResult[] = [
	{ name: "status is 200", passed: true },
	{ name: "body names a pet", passed: false, error: "expected undefined to equal 'Rex'" },
];

const step = (over: Partial<ScenarioStepRow> = {}): ScenarioStepRow => ({
	iteration: 0,
	stepIndex: 0,
	name: "Get pet",
	outcome: "failed",
	statusCode: 200,
	latencyMs: 12,
	...over,
});

/** A stored row whose trace carries the engine's `scripts` node. */
const storedWith = (testResults: TestResult[]): ScenarioStepRow["result"] => ({
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	latencyMs: 12,
	trace: {
		iteration: 0,
		stepIndex: 0,
		response: { headers: {}, body: "{}" },
		scripts: { testResults },
	},
});

function renderCard(row: ScenarioStepRow, isExpanded = false) {
	return render(
		<ScenarioStepCard
			step={row}
			showIteration={false}
			isExpanded={isExpanded}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

describe("ScenarioStepCard script results", () => {
	it("lists every assertion inside the expansion, not just the summary line", () => {
		renderCard(step({ result: storedWith(RESULTS) }), true);

		expect(screen.getByText("status is 200")).toBeTruthy();
		expect(screen.getByText("body names a pet")).toBeTruthy();
		// The reason, which is the part that makes the failure actionable - the
		// step's `error` column only ever carried the first failure's name.
		expect(screen.getByText(/expected undefined to equal/)).toBeTruthy();
	});

	/**
	 * The acceptance criterion in the issue's own words: a step's detail shows
	 * *the same* list its single Send shows. Driving the shared component with
	 * the same input and comparing is what keeps this from becoming a second
	 * rendering of one list - a copy would not receive that component's fixes.
	 */
	it("renders the same list the response pane's Tests tab renders", () => {
		const pane = render(<TestResults results={RESULTS} inset={false} />);
		const paneText = pane.container.textContent;
		pane.unmount();

		renderCard(step({ result: storedWith(RESULTS) }), true);

		// The card's expansion carries the response viewer too, so the list is
		// asserted as a substring of the card rather than as its whole text.
		expect(paneText).toBeTruthy();
		expect(document.body.textContent).toContain(paneText);
	});

	it("shows a passing step's evidence too, not only a failing one's", () => {
		// "Zero evidence its assertions ran at all" is half of what this fixes,
		// and it is the half a failure-only test would miss.
		renderCard(
			step({
				outcome: "passed",
				result: storedWith([{ name: "status is 200", passed: true }]),
			}),
			true
		);

		expect(screen.getByText("status is 200")).toBeTruthy();
		expect(screen.getByText("1 test passed")).toBeTruthy();
	});

	it("keeps a pre-request assertion in the step it failed, under its own script", () => {
		// The step this list could not account for (issue #810): a pre-request
		// assertion has always decided the outcome and always named the error
		// line, while the list beside it held the test script's alone. Both
		// phases are listed now, and the heading is what keeps an assertion made
		// before the request from reading as one about the response.
		renderCard(
			step({
				result: storedWith([
					{ name: "token was issued", passed: false, source: "pre" },
					{ name: "status is 200", passed: true, source: "test" },
				]),
			}),
			true
		);

		expect(screen.getByText("token was issued")).toBeTruthy();
		expect(screen.getByText("Pre-request Script")).toBeTruthy();
		// And it is counted: the chip reads the stored list, which is now what
		// the engine's live tally counted for the same step.
		expect(screen.getByText("1 passed, 1 failed")).toBeTruthy();
	});

	it("summarises a live step from the frame's tally, before any stored row exists", () => {
		// A collection run has no live delivery for the list - every step is
		// viewed through its stored trace - so the tally is all a run being
		// watched can say, and saying nothing is what this fixes.
		renderCard(step({ tests: { passed: 1, failed: 1 } }));

		expect(screen.getByText("1 passed, 1 failed")).toBeTruthy();
	});

	it("reads the same tally live and back from the stored list", () => {
		const live = renderCard(step({ tests: { passed: 1, failed: 1 } }));
		const liveText = screen.getByText(/passed/).textContent;
		live.unmount();

		renderCard(step({ result: storedWith(RESULTS) }));

		// One step, one pair of numbers: the stored list is the assertions the
		// live tally counted, so the row must not change what it says when the
		// run ends.
		expect(screen.getByText(/passed/).textContent).toBe(liveText);
	});

	it("shows no tally and no list for a step that asserted nothing", () => {
		renderCard(
			step({
				outcome: "passed",
				result: {
					timestamp: 1_700_000_000_000,
					statusCode: 200,
					latencyMs: 12,
					trace: {
						iteration: 0,
						stepIndex: 0,
						response: { headers: {}, body: "{}" },
					},
				},
			}),
			true
		);

		// A scriptless step is not a step whose assertions all held.
		expect(screen.queryByText(/tests? passed/)).toBeNull();
		expect(screen.queryByText(/passed,/)).toBeNull();
	});
});
