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

	it("offers no link on a live row, whose frame carries no request id", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		useScenarioRunStore.getState().startRun("run-1");
		useScenarioRunStore.getState().addStep({
			iteration: 0,
			stepIndex: 0,
			name: "Log in",
			outcome: "failed",
			statusCode: 500,
			latencyMs: 3,
		});

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

describe("searching the step list by name", () => {
	/** The search box, addressed the way a reader addresses it. */
	function search() {
		return screen.getByRole("textbox", { name: /search steps by name/i });
	}

	function type(value: string) {
		fireEvent.change(search(), { target: { value } });
	}

	beforeEach(() => {
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "failed", { name: "POST /checkout" }),
				storedStep(0, 1, "passed", { name: "GET /cart" }),
				storedStep(1, 0, "passed", { name: "POST /checkout" }),
				storedStep(1, 1, "skipped", { name: "GET /orders" }),
			],
		});
	});

	it("narrows the list to the steps whose name matches", () => {
		render(<ScenarioRunView run={RUN} />);

		type("checkout");

		// Both executions of the one step, and neither of the others - a name
		// repeated per iteration is exactly what the chips cannot separate.
		expect(screen.getAllByText("POST /checkout")).toHaveLength(2);
		expect(screen.queryByText("GET /cart")).toBeNull();
		expect(screen.queryByText("GET /orders")).toBeNull();
	});

	it("says on the field itself which field it matches", () => {
		render(<ScenarioRunView run={RUN} />);

		// Rows carry a name, a status code and a latency; which one is searched
		// is not guessable from a bare magnifier.
		expect(search()).toHaveAttribute("placeholder", "Search step names");
	});

	it("composes with the outcome filter, in either order", () => {
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(chip("failed"));
		type("checkout");

		// "the failed executions of POST /checkout" - one of the two.
		expect(screen.getAllByText("POST /checkout")).toHaveLength(1);
		expect(screen.queryByText("GET /cart")).toBeNull();

		// The other order reaches the same list: the two are one predicate,
		// not a filter applied to a filter's output.
		type("");
		setOutcome(null);
		type("checkout");
		fireEvent.click(chip("failed"));

		expect(screen.getAllByText("POST /checkout")).toHaveLength(1);
		expect(screen.queryByText("GET /cart")).toBeNull();
	});

	function setOutcome(outcome: StepOutcome | null) {
		if (outcome === null) {
			for (const o of ["passed", "failed", "skipped", "errored"] as StepOutcome[]) {
				if (chip(o).getAttribute("aria-pressed") === "true") fireEvent.click(chip(o));
			}
			return;
		}
		fireEvent.click(chip(outcome));
	}

	it("names the search when the search alone emptied the list", () => {
		render(<ScenarioRunView run={RUN} />);

		type("/refunds");

		expect(screen.getByText('No steps matching "/refunds"')).toBeTruthy();
		// Not the chip: the reader has to know which control to clear.
		expect(screen.queryByText(/no passed steps/i)).toBeNull();
		expect(screen.getByText(/matches the step name/i)).toBeTruthy();
	});

	it("names both controls when both narrowed it to nothing", () => {
		render(<ScenarioRunView run={RUN} />);

		fireEvent.click(chip("errored"));
		type("checkout");

		expect(screen.getByText('No errored steps matching "checkout"')).toBeTruthy();
		expect(screen.getByText(/errored chip and the search/i)).toBeTruthy();
	});

	it("leaves the run's own emptiness to the run, not to the search", () => {
		reportQuery.data = report({ results: [] });
		render(<ScenarioRunView run={RUN} />);

		// A completed run that stored nothing, with the field untouched: the
		// empty state is the run's, and a filter message here would blame a
		// control nobody used.
		expect(screen.getByText(/no steps recorded/i)).toBeTruthy();
	});

	it("restarts the growing window when a search narrows the list", () => {
		reportQuery.data = report({
			results: Array.from({ length: 5_000 }, (_, i) =>
				storedStep(i, 0, "passed", { name: i % 10 === 0 ? "POST /checkout" : "GET /cart" })
			),
		});
		render(<ScenarioRunView run={RUN} />);

		type("checkout");

		// The window keys off the total, so a narrowed list starts at its own
		// top rather than deep inside the one before it.
		expect(screen.getByText(/showing 200 of 500 steps/i)).toBeTruthy();
	});
});
