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
 * The collection-run tab.
 *
 * Four things are worth pinning here and none of them are layout: that a live
 * `step` event reaches the list, that all four outcomes render distinctly and
 * `skipped` is counted apart from `passed`, that a stored step's response comes
 * back through the shared restore path rather than a second reading of the
 * trace, and that a run whose step store filled says so.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import ScenarioRunView from "./ScenarioRunView";
import { useScenarioRunStore } from "@/stores";
import type { Run, RunReport, StepOutcome } from "@/types";

const reportQuery = {
	data: undefined as RunReport | undefined,
	isLoading: false,
};

vi.mock("@/queries", () => ({
	useRunReportQuery: () => reportQuery,
}));

// Monaco under the response body is irrelevant to every question here and
// costs a jsdom mount per expanded row.
vi.mock("@/components/shared/response-viewer/ResponseBody", () => ({
	default: ({ body }: { body: string }) => <div data-testid="response-body">{body}</div>,
}));

const RUN: Run = { id: "run-1", type: "scenario", status: "completed", startTime: 1, endTime: 2 };

function report(partial: Partial<RunReport>): RunReport {
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
		...partial,
	};
}

function storedStep(
	iteration: number,
	stepIndex: number,
	outcome: StepOutcome,
	overrides: { name?: string; body?: string; statusCode?: number } = {}
) {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: overrides.statusCode ?? 200,
		statusText: "OK",
		latencyMs: 12.5,
		trace: {
			iteration,
			stepIndex,
			stepName: overrides.name ?? `Step ${stepIndex + 1}`,
			requestId: `req_${stepIndex}`,
			outcome,
			request: { method: "GET", url: "https://example.test/", headers: {} },
			response: {
				headers: { "content-type": "application/json" },
				body: overrides.body ?? '{"ok":true}',
			},
		},
	};
}

/** The four-number summary chips, read by their data attribute. */
function outcomeCount(outcome: StepOutcome): string {
	const chip = document.querySelector(`[data-outcome-count="${outcome}"]`);
	return chip?.textContent ?? "";
}

beforeEach(() => {
	reportQuery.data = undefined;
	reportQuery.isLoading = false;
	useScenarioRunStore.setState({ runId: null, steps: [], isStreaming: false, error: null });
});

describe("live progress", () => {
	it("advances the list as step events arrive", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		expect(screen.getByText(/waiting for the first step/i)).toBeTruthy();

		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			store.addStep({
				iteration: 0,
				stepIndex: 0,
				name: "Log in",
				outcome: "passed",
				statusCode: 200,
				latencyMs: 40,
			});
		});

		expect(screen.getByText("Log in")).toBeTruthy();

		act(() => {
			useScenarioRunStore.getState().addStep({
				iteration: 0,
				stepIndex: 1,
				name: "Browse",
				outcome: "failed",
				statusCode: 200,
				latencyMs: 12,
			});
		});

		expect(screen.getByText("Browse")).toBeTruthy();
		expect(outcomeCount("passed")).toContain("1");
		expect(outcomeCount("failed")).toContain("1");
	});

	it("does not duplicate a row when the stream replays after a gap", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			for (const step of [0, 1, 0, 1]) {
				store.addStep({
					iteration: 0,
					stepIndex: step,
					name: `Step ${step + 1}`,
					outcome: "passed",
					statusCode: 200,
					latencyMs: 1,
				});
			}
		});

		expect(screen.getAllByText("Step 1")).toHaveLength(1);
		expect(outcomeCount("passed")).toContain("2");
	});

	it("ignores steps belonging to a different run", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		act(() => {
			const store = useScenarioRunStore.getState();
			// A second run started elsewhere; this tab is not it.
			store.startRun("run-2");
			store.addStep({
				iteration: 0,
				stepIndex: 0,
				name: "Somebody else's step",
				outcome: "passed",
				statusCode: 200,
				latencyMs: 1,
			});
		});

		expect(screen.queryByText("Somebody else's step")).toBeNull();
	});
});

describe("outcomes", () => {
	it("renders all four distinctly and counts skipped apart from passed", () => {
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "passed", { name: "One" }),
				storedStep(0, 1, "failed", { name: "Two" }),
				storedStep(0, 2, "skipped", { name: "Three" }),
				storedStep(0, 3, "errored", { name: "Four" }),
			],
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 4,
				passed: 1,
				failed: 1,
				skipped: 1,
				errored: 1,
				stepsStored: 4,
				stepsDropped: 0,
			},
		});

		render(<ScenarioRunView run={RUN} />);

		// Four separate numbers, not two. Fold `skipped` into `passed` and the
		// first two assertions flip to 2 and 0.
		expect(outcomeCount("passed")).toContain("1");
		expect(outcomeCount("skipped")).toContain("1");
		expect(outcomeCount("failed")).toContain("1");
		expect(outcomeCount("errored")).toContain("1");

		// And each row wears its own outcome, so a skipped step is never dressed
		// as a pass on the row either.
		for (const outcome of ["passed", "failed", "skipped", "errored"]) {
			expect(screen.getAllByText(outcome).length).toBeGreaterThan(0);
		}
	});

	it("gives a skipped step a different row treatment than a passed one", () => {
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "passed", { name: "Ran" }),
				storedStep(0, 1, "skipped", { name: "Did not run" }),
			],
		});

		render(<ScenarioRunView run={RUN} />);

		const passedRow = screen.getByText("Ran").closest("button")!;
		const skippedRow = screen.getByText("Did not run").closest("button")!;

		// The icon is what says "this one did not run" at a glance; sharing the
		// passed tint is the false-pass this pins against.
		const tint = (row: Element) =>
			Array.from(row.querySelectorAll("svg"))
				.map((n) => n.getAttribute("class") ?? "")
				.join(" ");
		expect(tint(passedRow)).toContain("text-status-success-text");
		expect(tint(skippedRow)).not.toContain("text-status-success-text");
	});
});

describe("stored step results", () => {
	it("restores a step's response through the shared restore path", () => {
		reportQuery.data = report({
			results: [storedStep(0, 0, "passed", { name: "Log in", body: '{"token":"abc"}' })],
		});

		render(<ScenarioRunView run={RUN} />);
		fireEvent.click(screen.getByText("Log in").closest("button")!);

		// The body reaches the pane, which only happens through
		// `responseFromRunResult` - the row itself never reads `trace.response`.
		expect(screen.getByTestId("response-body").textContent).toContain("abc");
	});

	it("shows the truncation notice a stored slice carries", () => {
		const step = storedStep(0, 0, "passed", { name: "Big" });
		step.trace.response = {
			...step.trace.response,
			bodyTruncated: true,
			bodyBytes: 1_048_576,
		} as never;
		reportQuery.data = report({ results: [step] });

		render(<ScenarioRunView run={RUN} />);
		fireEvent.click(screen.getByText("Big").closest("button")!);

		expect(screen.getByText(/body truncated for storage/i)).toBeTruthy();
	});

	it("expands a live row that has no stored exchange yet without inventing one", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);
		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			store.addStep({
				iteration: 0,
				stepIndex: 0,
				name: "In flight",
				outcome: "passed",
				statusCode: 200,
				latencyMs: 5,
			});
		});

		fireEvent.click(screen.getByText("In flight").closest("button")!);

		expect(screen.queryByTestId("response-body")).toBeNull();
	});
});

describe("iterations", () => {
	it("labels rows by iteration once a run has more than one", () => {
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "passed", { name: "Only step" }),
				storedStep(1, 0, "passed", { name: "Only step" }),
			],
		});

		render(<ScenarioRunView run={RUN} />);

		expect(screen.getByText("Iteration 1")).toBeTruthy();
		expect(screen.getByText("Iteration 2")).toBeTruthy();
	});

	it("says nothing about iterations for a single pass", () => {
		reportQuery.data = report({ results: [storedStep(0, 0, "passed", { name: "Only" })] });

		render(<ScenarioRunView run={RUN} />);

		expect(screen.queryByText(/^Iteration/)).toBeNull();
	});
});

describe("thinned results", () => {
	it("discloses what a filled step store dropped", () => {
		reportQuery.data = report({
			results: [storedStep(0, 0, "failed", { name: "Kept" })],
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 10_000,
				passed: 9_999,
				failed: 1,
				skipped: 0,
				errored: 0,
				stepsStored: 5_000,
				stepsDropped: 5_000,
			},
		});

		render(<ScenarioRunView run={RUN} />);

		const notice = screen.getByText(/bounded step storage/i).closest("div")!;
		expect(within(notice).getByText(/5,000/)).toBeTruthy();
		expect(notice.textContent).toContain("every step that did not pass was kept");
	});

	it("stays silent when the run dropped nothing", () => {
		reportQuery.data = report({
			results: [storedStep(0, 0, "passed", { name: "Kept" })],
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 1,
				passed: 1,
				failed: 0,
				skipped: 0,
				errored: 0,
				stepsStored: 1,
				stepsDropped: 0,
			},
		});

		render(<ScenarioRunView run={RUN} />);

		expect(screen.queryByText(/bounded step storage/i)).toBeNull();
	});
});

describe("empty and loading", () => {
	it("says the run stored no steps rather than sitting blank", () => {
		reportQuery.data = report({ results: [] });

		render(<ScenarioRunView run={RUN} />);

		expect(screen.getByText(/no steps recorded/i)).toBeTruthy();
	});

	it("waits rather than claiming emptiness while the report is loading", () => {
		reportQuery.isLoading = true;

		render(<ScenarioRunView run={RUN} />);

		expect(screen.getByText(/waiting for the first step/i)).toBeTruthy();
		expect(screen.queryByText(/no steps recorded/i)).toBeNull();
	});
});
