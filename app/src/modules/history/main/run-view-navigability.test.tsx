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
 * Getting *out* of a collection run's step list, and reading one that is long
 * (issue #730).
 *
 * Three things are pinned here, and none of them is layout:
 *
 * - a step's way back to the request that ran it, carrying the row that
 *   iteration bound - the dead end the issue is about, and the half
 *   (`requestId`, stamped by the engine since the runner existed) that no
 *   renderer read;
 * - the four count chips narrowing the list to one outcome, including the case
 *   where a chip's number is the *run's* and the rows are the *store's*, which
 *   thinning makes different numbers;
 * - the list staying bounded in what it mounts at the storage cap, which is
 *   `maxScenarioStoredSteps` = 5,000 cards.
 *
 * The last one asserts what is mounted rather than a scroll behaviour: jsdom
 * has no layout, so the growing window is put under test with a stub observer
 * that never fires - the first slice renders and nothing grows it. Without the
 * stub the hook honestly falls back to rendering everything, which is right for
 * a browser that cannot window and is not what this checks.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import ScenarioRunView from "./ScenarioRunView";
import { useScenarioRunStore, useTabsStore } from "@/stores";
import type { Run, RunReport, StepOutcome } from "@/types";

const reportQuery = {
	data: undefined as RunReport | undefined,
	isLoading: false,
};

vi.mock("@/queries", () => ({
	useRunReportQuery: () => reportQuery,
}));

vi.mock("@/services/api", () => ({
	apiService: { stopRun: vi.fn(async () => ({})) },
}));

// Monaco under an expanded row is irrelevant to every question here.
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
	overrides: { requestId?: string | null; dataRowIndex?: number; name?: string } = {}
) {
	const trace: Record<string, unknown> = {
		iteration,
		stepIndex,
		stepName: overrides.name ?? `Step ${stepIndex + 1}`,
		outcome,
		response: { headers: {}, body: "{}" },
	};
	if (overrides.requestId !== null) trace.requestId = overrides.requestId ?? `req_${stepIndex}`;
	if (overrides.dataRowIndex !== undefined) trace.dataRowIndex = overrides.dataRowIndex;
	return { timestamp: 1_700_000_000_000, statusCode: 200, latencyMs: 5, trace };
}

/** The step rows currently mounted, by their expand toggle. */
function stepRows() {
	return screen.queryAllByRole("button", { expanded: false });
}

function chip(outcome: StepOutcome) {
	return screen.getByRole("button", { name: `Show only ${outcome} steps` });
}

beforeAll(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
			root = null;
			rootMargin = "";
			thresholds = [];
		}
	);
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
	reportQuery.data = undefined;
	reportQuery.isLoading = false;
	useScenarioRunStore.setState({ runId: null, steps: [], isStreaming: false, error: null });
	useTabsStore.setState({
		openTabs: [],
		activeTabId: null,
		tabFocusedAt: {},
		dataRowTarget: null,
	});
});

describe("a step's way back to its request", () => {
	it("opens the request the step ran, with the row that iteration bound", () => {
		reportQuery.data = report({
			results: [
				storedStep(500, 0, "failed", {
					requestId: "req_checkout",
					dataRowIndex: 500,
					name: "Checkout",
				}),
			],
		});
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(screen.getByRole("button", { name: /row 501 selected/i }));

		const { openTabs, dataRowTarget } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0]).toMatchObject({ type: "request", entityId: "req_checkout" });
		// The row travels with the navigation - reproducing "row 501 failed"
		// against row 1 would be a different send entirely.
		expect(dataRowTarget).toEqual({ requestId: "req_checkout", rowIndex: 500 });
	});

	it("names the row on the control, since that is the number being reproduced", () => {
		reportQuery.data = report({
			results: [storedStep(0, 0, "failed", { dataRowIndex: 3 })],
		});
		render(<ScenarioRunView run={RUN} />);

		expect(screen.getByRole("button", { name: /row 4 selected/i }).textContent).toContain(
			"Repro row 4"
		);
	});

	it("opens the request with no row for a run that bound no data set", () => {
		reportQuery.data = report({ results: [storedStep(0, 0, "failed")] });
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(screen.getByRole("button", { name: /open the request/i }));

		// No target at all rather than row 0: a collection with no data set has
		// no row to select, and row 1 of a file it never read is a fiction.
		expect(useTabsStore.getState().dataRowTarget).toBeNull();
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ entityId: "req_0" });
	});

	it("offers no link on a row that cannot name a request", () => {
		// A row stored before the runner stamped one. Absent, not disabled: the
		// card cannot open what the row does not name.
		reportQuery.data = report({
			results: [storedStep(0, 0, "failed", { requestId: null })],
		});
		render(<ScenarioRunView run={RUN} />);

		expect(screen.queryByRole("button", { name: /open the request/i })).toBeNull();
	});

	it("opens the request from a live row, with the row that iteration bound", () => {
		// The failure being watched arrive is when this link is worth most, so
		// the frame names the request (issue #831) and the row does not wait
		// for the run's stored rows to be written.
		useScenarioRunStore.getState().startRun("run-1");
		useScenarioRunStore.getState().addStep({
			iteration: 11,
			stepIndex: 0,
			name: "Checkout",
			outcome: "failed",
			statusCode: 500,
			latencyMs: 3,
			requestId: "req_checkout",
			dataRowIndex: 11,
		});
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		fireEvent.click(screen.getByRole("button", { name: /row 12 selected/i }));

		const { openTabs, dataRowTarget } = useTabsStore.getState();
		expect(openTabs[0]).toMatchObject({ type: "request", entityId: "req_checkout" });
		expect(dataRowTarget).toEqual({ requestId: "req_checkout", rowIndex: 11 });
	});

	it("offers no link on a live row whose frame names no request", () => {
		// A step whose plan entry has no stored request behind it. Absent, not
		// disabled, on the same terms as the stored row above.
		useScenarioRunStore.getState().startRun("run-1");
		useScenarioRunStore.getState().addStep({
			iteration: 0,
			stepIndex: 0,
			name: "Log in",
			outcome: "failed",
			statusCode: 500,
			latencyMs: 3,
		});
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		// The row is on screen - otherwise this asserts the absence of a link on
		// a list that rendered nothing at all.
		expect(screen.getByText("Log in")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /open the request/i })).toBeNull();
	});
});

describe("the count chips as the filter", () => {
	beforeEach(() => {
		reportQuery.data = report({
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 4,
				stepsStored: 4,
				stepsDropped: 0,
				passed: 2,
				failed: 1,
				skipped: 1,
				errored: 0,
			},
			results: [
				storedStep(0, 0, "passed", { name: "One" }),
				storedStep(0, 1, "failed", { name: "Two" }),
				storedStep(0, 2, "passed", { name: "Three" }),
				storedStep(0, 3, "skipped", { name: "Four" }),
			],
		});
	});

	it("narrows the list to the outcome whose chip was pressed", () => {
		render(<ScenarioRunView run={RUN} />);
		expect(screen.getByText("One")).toBeTruthy();

		fireEvent.click(chip("failed"));

		expect(screen.getByText("Two")).toBeTruthy();
		expect(screen.queryByText("One")).toBeNull();
		expect(screen.queryByText("Four")).toBeNull();
		expect(chip("failed")).toHaveAttribute("aria-pressed", "true");
	});

	it("clears the filter when the pressed chip is pressed again", () => {
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(chip("skipped"));
		expect(screen.queryByText("One")).toBeNull();

		fireEvent.click(chip("skipped"));

		expect(screen.getByText("One")).toBeTruthy();
		expect(screen.getByText("Two")).toBeTruthy();
		expect(chip("skipped")).toHaveAttribute("aria-pressed", "false");
	});

	it("keeps the whole-run number on the chip while filtering the stored rows", () => {
		reportQuery.data = report({
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 6_000,
				stepsStored: 1,
				stepsDropped: 5_999,
				passed: 5_999,
				failed: 1,
				skipped: 0,
				errored: 0,
			},
			// Thinning keeps what did not pass; every success was dropped.
			results: [storedStep(0, 0, "failed", { name: "The one that failed" })],
		});
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(chip("passed"));

		// The chip is not wrong and the list is not lying - they count different
		// things, and the empty state is where that is said rather than left as
		// a contradiction.
		expect(chip("passed").textContent).toContain("5999 passed");
		expect(screen.getByText(/no passed steps in the stored rows/i)).toBeTruthy();
		expect(screen.getByText(/dropped successes/i)).toBeTruthy();
	});
});

describe("a run at the storage cap", () => {
	it("does not mount 5,000 cards to show the first screen of them", () => {
		reportQuery.data = report({
			results: Array.from({ length: 5_000 }, (_, i) => storedStep(i, 0, "passed")),
		});

		render(<ScenarioRunView run={RUN} />);

		// The window is 200 rows; what matters is that it is bounded and far
		// below the cap, not the exact figure.
		const mounted = stepRows().length;
		expect(mounted).toBeGreaterThan(0);
		expect(mounted).toBeLessThan(1_000);
		// Nothing is withheld: the line says what is still to come.
		expect(screen.getByText(/showing 200 of 5,000 steps/i)).toBeTruthy();
	});

	it("counts the filtered list, not the whole one, in what is still to come", () => {
		reportQuery.data = report({
			results: Array.from({ length: 5_000 }, (_, i) =>
				storedStep(i, 0, i % 10 === 0 ? "failed" : "passed")
			),
		});
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(chip("failed"));

		expect(screen.getByText(/showing 200 of 500 steps/i)).toBeTruthy();
	});
});
