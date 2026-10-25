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
 * What the extracted sections do at their own prop boundary. The dialog's
 * suite drives them through the whole form with `isStarting` always false, so
 * the one branch it cannot reach - a section told it is disabled - is pinned
 * here.
 */

import type { ComponentProps } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BudgetsSection } from "./BudgetsSection";
import {
	CAPACITY_BUDGETS_NOTE,
	CAPACITY_SEED_HINT,
	emptyBudgetDraft,
	emptyCustomBudgetRow,
} from "./budgets";
import type { LoadTestConfig } from "@/types";

afterEach(cleanup);

function renderBudgets(
	disabled: boolean,
	{
		mode = "constant_concurrency",
		budgets = emptyBudgetDraft(),
		budgetSources = {},
	}: {
		mode?: LoadTestConfig["mode"];
		budgets?: ReturnType<typeof emptyBudgetDraft>;
		budgetSources?: ComponentProps<typeof BudgetsSection>["budgetSources"];
	} = {}
) {
	render(
		<BudgetsSection
			mode={mode}
			budgetSources={budgetSources}
			budgets={budgets}
			onBudgetsChange={() => {}}
			customBudgets={[emptyCustomBudgetRow()]}
			onCustomBudgetsChange={() => {}}
			failRun={false}
			onFailRunChange={() => {}}
			disabled={disabled}
		/>
	);
	fireEvent.click(screen.getByRole("button", { name: /pass\/fail budgets/i }));
}

describe("BudgetsSection", () => {
	it("locks the custom rows while the run is starting", () => {
		renderBudgets(true);
		expect(screen.getByLabelText(/custom budget 1 metric name/i)).toBeDisabled();
		expect(screen.getByLabelText(/custom budget 1 ceiling/i)).toBeDisabled();
		expect(screen.getByRole("button", { name: /remove custom budget 1/i })).toBeDisabled();
		expect(screen.getByRole("button", { name: /add custom metric budget/i })).toBeDisabled();
	});

	it("leaves the custom rows editable otherwise", () => {
		renderBudgets(false);
		expect(screen.getByLabelText(/custom budget 1 metric name/i)).toBeEnabled();
		expect(screen.getByRole("button", { name: /add custom metric budget/i })).toBeEnabled();
	});

	describe("in Capacity discovery (issue #2816)", () => {
		const seeded = { ...emptyBudgetDraft(), latencyP99Ms: "500" };

		it("says a latency budget is judged over every level of the search", () => {
			renderBudgets(false, { mode: "capacity" });
			expect(screen.getByText(CAPACITY_BUDGETS_NOTE)).toBeInTheDocument();
		});

		it.each(["constant_concurrency", "ramp_up", "constant_rps", "iterations"] as const)(
			"says nothing of the sort in %s",
			(mode) => {
				renderBudgets(false, { mode });
				expect(screen.queryByText(CAPACITY_BUDGETS_NOTE)).not.toBeInTheDocument();
			}
		);

		it("does not count the unsent Settings seed on the closed card", () => {
			renderBudgets(false, {
				mode: "capacity",
				budgets: seeded,
				budgetSources: { latencyP99Ms: "slo" },
			});
			expect(screen.getByRole("button", { name: /pass\/fail budgets/i })).toHaveTextContent(
				"No budgets"
			);
		});

		it("says the seeded p99 is not sent, but still shows it", () => {
			renderBudgets(false, {
				mode: "capacity",
				budgets: seeded,
				budgetSources: { latencyP99Ms: "slo" },
			});
			expect(screen.getByLabelText(/^p99 latency/i)).toHaveValue(500);
			expect(screen.getByText(CAPACITY_SEED_HINT)).toBeInTheDocument();
		});

		it("counts a p99 the memo carried, and claims no seed for it", () => {
			renderBudgets(false, {
				mode: "capacity",
				budgets: seeded,
				budgetSources: { latencyP99Ms: "memo" },
			});
			expect(screen.getByRole("button", { name: /pass\/fail budgets/i })).toHaveTextContent(
				"1 budget active"
			);
			expect(screen.queryByText(CAPACITY_SEED_HINT)).not.toBeInTheDocument();
		});

		it("still counts and describes the seed in a mode that sends it", () => {
			renderBudgets(false, {
				mode: "ramp_up",
				budgets: seeded,
				budgetSources: { latencyP99Ms: "slo" },
			});
			expect(screen.getByRole("button", { name: /pass\/fail budgets/i })).toHaveTextContent(
				"1 budget active"
			);
			expect(screen.queryByText(CAPACITY_SEED_HINT)).not.toBeInTheDocument();
		});
	});
});
