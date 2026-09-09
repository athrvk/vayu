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
	it("says nothing when the report has no elements section", () => {
		const { container } = render(<RequestElementsSummary elements={undefined} />);
		expect(container.firstChild).toBeNull();
	});

	it("says nothing when the elements array is empty", () => {
		const { container } = render(<RequestElementsSummary elements={[]} />);
		expect(container.firstChild).toBeNull();
	});

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
