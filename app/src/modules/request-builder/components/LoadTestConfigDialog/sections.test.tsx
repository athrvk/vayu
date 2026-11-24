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
 * here. `RetryAfterFields` is shared by two dialogs, so its own contract (the
 * mode guard, the ids, the cap's visibility) is pinned here rather than through
 * either.
 */

import type { ComponentProps } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { BudgetsSection } from "./BudgetsSection";
import { RetryAfterFields } from "./RetryAfterFields";
import { LOAD_TEST_LIMITS } from "@/constants/load-test";
import {
	CAPACITY_BUDGETS_NOTE,
	CAPACITY_SEED_HINT,
	STREAM_LATENCY_NOTE,
	STREAM_SEED_HINT,
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

	describe("on a streaming request (issue #3772)", () => {
		const seeded = { ...emptyBudgetDraft(), latencyP99Ms: "500" };
		const slo = { latencyP99Ms: "slo" } as const;
		const closedCard = () => screen.getByRole("button", { name: /pass\/fail budgets/i });

		it("does not count the unsent Settings seed on the closed card", () => {
			renderBudgets(false, { isStreamingRequest: true, budgets: seeded, budgetSources: slo });
			expect(closedCard()).toHaveTextContent("No budgets");
		});

		it("says the seeded p99 is not sent by a streaming request, but still shows it", () => {
			renderBudgets(false, { isStreamingRequest: true, budgets: seeded, budgetSources: slo });
			expect(screen.getByLabelText(/^p99 latency/i)).toHaveValue(500);
			expect(screen.getByText(STREAM_SEED_HINT)).toBeInTheDocument();
			expect(screen.queryByText(CAPACITY_SEED_HINT)).not.toBeInTheDocument();
		});

		it("does not show the capacity note, which is about the search", () => {
			renderBudgets(false, { isStreamingRequest: true, budgets: seeded, budgetSources: slo });
			expect(screen.queryByText(CAPACITY_BUDGETS_NOTE)).not.toBeInTheDocument();
		});

		it("names the capacity reason, not the stream one, when both apply", () => {
			renderBudgets(false, {
				mode: "capacity",
				isStreamingRequest: true,
				budgets: seeded,
				budgetSources: slo,
			});
			expect(screen.getByText(CAPACITY_SEED_HINT)).toBeInTheDocument();
			expect(screen.queryByText(STREAM_SEED_HINT)).not.toBeInTheDocument();
		});

		it("counts a p99 the memo carried, and claims no seed for it", () => {
			renderBudgets(false, {
				isStreamingRequest: true,
				budgets: seeded,
				budgetSources: { latencyP99Ms: "memo" },
			});
			expect(closedCard()).toHaveTextContent("1 budget active");
			expect(screen.queryByText(STREAM_SEED_HINT)).not.toBeInTheDocument();
		});

		it("still counts and describes the seed when the request does not stream", () => {
			renderBudgets(false, {
				isStreamingRequest: false,
				budgets: seeded,
				budgetSources: slo,
			});
			expect(closedCard()).toHaveTextContent("1 budget active");
			expect(screen.queryByText(STREAM_SEED_HINT)).not.toBeInTheDocument();
		});
	});
});

describe("RetryAfterFields (#3799)", () => {
	function renderFields({
		mode = "constant_concurrency",
		backoff = false,
		idPrefix = "x",
		onBackoffChange = vi.fn(),
		onMaxMsChange = vi.fn(),
	}: {
		mode?: LoadTestConfig["mode"];
		backoff?: boolean;
		idPrefix?: string;
		onBackoffChange?: (value: boolean) => void;
		onMaxMsChange?: (value: number) => void;
	} = {}) {
		render(
			<RetryAfterFields
				mode={mode}
				limits={LOAD_TEST_LIMITS}
				idPrefix={idPrefix}
				backoff={backoff}
				onBackoffChange={onBackoffChange}
				maxMs={2500}
				onMaxMsChange={onMaxMsChange}
			/>
		);
	}
	const toggle = () => screen.queryByRole("switch", { name: /wait out retry-after/i });

	it.each(["constant_concurrency", "iterations", "ramp_up", "capacity"] as const)(
		"offers the switch in %s",
		(mode) => {
			renderFields({ mode });
			expect(toggle()).toBeInTheDocument();
		}
	);

	it("offers nothing in constant_rps, which the engine would only skip with a warning", () => {
		renderFields({ mode: "constant_rps", backoff: true });
		expect(toggle()).toBeNull();
		expect(screen.queryByLabelText(/longest retry-after wait/i)).toBeNull();
	});

	it("shows the cap only with the switch on", () => {
		renderFields({ backoff: false });
		expect(screen.queryByLabelText(/longest retry-after wait/i)).toBeNull();
		cleanup();

		renderFields({ backoff: true });
		expect(screen.getByLabelText(/longest retry-after wait/i)).toHaveValue(2500);
	});

	it("reports the switch and the typed cap", () => {
		const onBackoffChange = vi.fn();
		const onMaxMsChange = vi.fn();
		renderFields({ backoff: true, onBackoffChange, onMaxMsChange });
		fireEvent.click(toggle()!);
		expect(onBackoffChange).toHaveBeenCalledWith(false);
		fireEvent.change(screen.getByLabelText(/longest retry-after wait/i), {
			target: { value: "4000" },
		});
		expect(onMaxMsChange).toHaveBeenCalledWith(4000);
	});

	it("prefixes both ids, so two dialogs' controls never collide", () => {
		renderFields({ backoff: true, idPrefix: "run-collection" });
		expect(toggle()).toHaveAttribute("id", "run-collection-retry-after");
		expect(screen.getByLabelText(/longest retry-after wait/i)).toHaveAttribute(
			"id",
			"run-collection-retry-after-max"
		);
	});
});
