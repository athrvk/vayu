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
	STREAM_LATENCY_NOTE,
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
		isStreamingRequest = false,
	}: {
		mode?: LoadTestConfig["mode"];
		budgets?: ReturnType<typeof emptyBudgetDraft>;
		budgetSources?: ComponentProps<typeof BudgetsSection>["budgetSources"];
		isStreamingRequest?: boolean;
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
			isStreamingRequest={isStreamingRequest}
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

	describe("stream budgets (issue #3234)", () => {
		const remembered = {
			...emptyBudgetDraft(),
			streamTimeToFirstEventP95Ms: "800",
			streamEventsPerSecondMin: "200",
		};

		it("offers both, and the note on what the latency budgets measure, for a streaming request", () => {
			renderBudgets(false, { isStreamingRequest: true });
			expect(screen.getByLabelText(/^time to first event p95 at most/i)).toBeInTheDocument();
			expect(screen.getByLabelText(/^events per second at least/i)).toBeInTheDocument();
			expect(screen.getByText(STREAM_LATENCY_NOTE)).toBeInTheDocument();
		});

		it("offers neither, nor the note, for a request that does not stream", () => {
			renderBudgets(false, { isStreamingRequest: false });
			expect(screen.queryByLabelText(/time to first event/i)).not.toBeInTheDocument();
			expect(screen.queryByLabelText(/events per second/i)).not.toBeInTheDocument();
			expect(screen.queryByText(STREAM_LATENCY_NOTE)).not.toBeInTheDocument();
		});

		it("counts a remembered stream budget on the closed card only when the request streams", () => {
			renderBudgets(false, { budgets: remembered, isStreamingRequest: true });
			expect(screen.getByRole("button", { name: /pass\/fail budgets/i })).toHaveTextContent(
				"2 budgets active"
			);
			cleanup();

			renderBudgets(false, { budgets: remembered, isStreamingRequest: false });
			expect(screen.getByRole("button", { name: /pass\/fail budgets/i })).toHaveTextContent(
				"No budgets"
			);
		});
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
