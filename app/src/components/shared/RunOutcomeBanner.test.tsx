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
 * The verdict line a finished load run opens on (#2130).
 *
 * Mutation check: give `not-judged` the `positive` tick and the neutral case
 * reddens; make the component render "Not judged" for a null judgement and the
 * nothing-to-say case reddens.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunOutcomeBanner } from "./RunOutcomeBanner";
import type { RunJudgement } from "./run-outcome";

function banner(judgement: RunJudgement | null) {
	return render(<RunOutcomeBanner judgement={judgement} />);
}

describe("RunOutcomeBanner", () => {
	it("says Failed with the reason, on the destructive tint", () => {
		const { container } = banner({
			outcome: "failed",
			reason: "2 of 4 budgets missed: p95, throughput",
		});

		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(container.textContent).toContain("2 of 4 budgets missed: p95, throughput");
		expect(container.firstElementChild!.className).toContain("destructive");
	});

	it("says Passed with a success tick", () => {
		const { container } = banner({ outcome: "passed", reason: "All 3 budgets met" });

		expect(screen.getByText("Passed")).toBeInTheDocument();
		expect(container.querySelector("svg")!.getAttribute("class")).toContain(
			"text-status-success-text"
		);
	});

	it("keeps Not judged neutral - no green, no destructive tint", () => {
		const { container } = banner({
			outcome: "not-judged",
			reason: "No budgets set. 15.1% errors",
		});

		expect(screen.getByText("Not judged")).toBeInTheDocument();
		const html = container.innerHTML;
		expect(html).not.toContain("success");
		expect(html).not.toContain("destructive");
		expect(html).not.toContain("warning");
	});

	it("draws nothing when there is no verdict to state", () => {
		const { container } = banner(null);

		expect(container.firstChild).toBeNull();
	});
});
