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
 * Issue #1641: the engine wrote a single-request load run's per-element
 * tally into its report; nothing rendered it. Mutation check: drop the
 * emptiness guard and the "says nothing" cases fail; drop the component from
 * OverviewTab and its own rendering test still passes but the report
 * silently loses the row.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestElementsSummary } from "./RequestElementsSummary";
import type { RunScenarioStepElementTally } from "@/types/domain";

function tally(overrides: Partial<RunScenarioStepElementTally> = {}): RunScenarioStepElementTally {
	return { id: "el_1", kind: "assert.status", passed: 1, failed: 0, skipped: 0, ...overrides };
}

describe("RequestElementsSummary", () => {
	it.each([{ elements: undefined }, { elements: [] }])(
		"says nothing when the elements section is $elements",
		({ elements }) => {
			const { container } = render(<RequestElementsSummary elements={elements} />);
			expect(container.firstChild).toBeNull();
		}
	);

	it("shows a passing element's kind and count", () => {
		render(<RequestElementsSummary elements={[tally({ passed: 42 })]} />);
		expect(screen.getByText("assert.status")).toBeTruthy();
		expect(screen.getByText("42 passed")).toBeTruthy();
	});

	it("shows failed and skipped only when non-zero", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "extract.json", passed: 3, failed: 1, skipped: 2 })]}
			/>
		);
		expect(screen.getByText("3 passed")).toBeTruthy();
		expect(screen.getByText("1 failed")).toBeTruthy();
		expect(screen.getByText("2 skipped")).toBeTruthy();
	});

	it("omits failed and skipped rows at zero", () => {
		render(<RequestElementsSummary elements={[tally({ passed: 5 })]} />);
		expect(screen.queryByText(/failed/)).toBeNull();
		expect(screen.queryByText(/skipped/)).toBeNull();
	});

	describe("a deferred post-request script (issue #2144)", () => {
		const deferredScript = (overrides: Partial<RunScenarioStepElementTally> = {}) =>
			tally({ kind: "script.post", passed: 0, skipped: 0, deferred: 235_690, ...overrides });

		it("says it was replayed and where the results are, not '0 passed'", () => {
			render(<RequestElementsSummary elements={[deferredScript()]} />);

			expect(
				screen.getByText(
					"replayed on 235,690 sampled responses - results in Test Validation"
				)
			).toBeTruthy();
			expect(screen.queryByText(/passed/)).toBeNull();
			expect(screen.queryByText(/skipped/)).toBeNull();
		});

		it("uses the singular for one response", () => {
			render(<RequestElementsSummary elements={[deferredScript({ deferred: 1 })]} />);
			expect(
				screen.getByText("replayed on 1 sampled response - results in Test Validation")
			).toBeTruthy();
		});

		it("still states the other tallies when the row is mixed", () => {
			render(
				<RequestElementsSummary
					elements={[deferredScript({ deferred: 5, passed: 3, failed: 1, skipped: 2 })]}
				/>
			);
			expect(screen.getByText(/replayed on 5 sampled responses/)).toBeTruthy();
			expect(screen.getByText("3 passed")).toBeTruthy();
			expect(screen.getByText("1 failed")).toBeTruthy();
			expect(screen.getByText("2 skipped")).toBeTruthy();
		});

		it("keeps a skipped-only row, such as an un-inlined script.pre, as skipped", () => {
			render(
				<RequestElementsSummary
					elements={[tally({ kind: "script.pre", passed: 0, skipped: 9, deferred: 0 })]}
				/>
			);
			expect(screen.getByText("9 skipped")).toBeTruthy();
			expect(screen.getByText("0 passed")).toBeTruthy();
			expect(screen.queryByText(/replayed/)).toBeNull();
		});

		it("renders a report stored before the field as it always did", () => {
			render(<RequestElementsSummary elements={[tally({ passed: 0, skipped: 7 })]} />);
			expect(screen.getByText("0 passed")).toBeTruthy();
			expect(screen.getByText("7 skipped")).toBeTruthy();
			expect(screen.queryByText(/replayed/)).toBeNull();
		});
	});

	it("renders one row per element", () => {
		render(
			<RequestElementsSummary
				elements={[
					tally({ id: "el_1", kind: "assert.status" }),
					tally({ id: "el_2", kind: "timer.think" }),
				]}
			/>
		);
		expect(screen.getByText("assert.status")).toBeTruthy();
		expect(screen.getByText("timer.think")).toBeTruthy();
	});
});
