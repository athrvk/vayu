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
 * Five things are worth pinning here and none of them are layout: that a live
 * `step` event reaches the list, that all four outcomes render distinctly and
 * `skipped` is counted apart from `passed`, that a stored step's response comes
 * back through the shared restore path rather than a second reading of the
 * trace, that a run whose step store filled says so, and that a live run can be
 * stopped from here while a finished one offers nothing to stop.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import ScenarioRunView from "./ScenarioRunView";
import { useScenarioRunStore, useToastStore } from "@/stores";
import type { Run, RunReport, StepOutcome } from "@/types";

const reportQuery = {
	data: undefined as RunReport | undefined,
	isLoading: false,
};

vi.mock("@/queries", () => ({
	useRunReportQuery: () => reportQuery,
}));

const stopRun = vi.fn<(id: string) => Promise<unknown>>();

vi.mock("@/services/api", () => ({
	apiService: {
		stopRun: (id: string) => stopRun(id),
	},
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
	overrides: { name?: string; body?: string; statusCode?: number; dataRowIndex?: number } = {}
) {
	return {
		timestamp: 1_700_000_000_000,
		statusCode: overrides.statusCode ?? 200,
		statusText: "OK",
		latencyMs: 12.5,
		trace: {
			iteration,
			stepIndex,
			dataRowIndex: overrides.dataRowIndex,
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
	stopRun.mockReset();
	stopRun.mockResolvedValue({});
	useToastStore.setState({ toasts: [] });
});

/** The Stop control, or null when the tab is not offering one. */
function stopButton(): HTMLElement | null {
	return screen.queryByRole("button", { name: /^stop/i });
}

describe("live progress", () => {
	it("advances the list as step events arrive", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		expect(screen.getByText(/waiting for the first step/i)).toBeTruthy();

		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			store.addSteps([
				{
					iteration: 0,
					stepIndex: 0,
					name: "Log in",
					outcome: "passed",
					statusCode: 200,
					latencyMs: 40,
				},
			]);
		});

		expect(screen.getByText("Log in")).toBeTruthy();

		act(() => {
			useScenarioRunStore.getState().addSteps([
				{
					iteration: 0,
					stepIndex: 1,
					name: "Browse",
					outcome: "failed",
					statusCode: 200,
					latencyMs: 12,
				},
			]);
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
				store.addSteps([
					{
						iteration: 0,
						stepIndex: step,
						name: `Step ${step + 1}`,
						outcome: "passed",
						statusCode: 200,
						latencyMs: 1,
					},
				]);
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
			store.addSteps([
				{
					iteration: 0,
					stepIndex: 0,
					name: "Somebody else's step",
					outcome: "passed",
					statusCode: 200,
					latencyMs: 1,
				},
			]);
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

	/**
	 * Issue #726. Thinning drops passing rows only, so tallying the rows makes
	 * the `passed` chip mean something different per run size - and disagree
	 * with the step total in the same header strip.
	 */
	it("counts the whole run on a thinned run, not the rows that survived", () => {
		reportQuery.data = report({
			// One row kept out of 6,000 executed - the failure, as thinning
			// guarantees.
			results: [storedStep(0, 0, "failed", { name: "Kept" })],
			scenario: {
				iterations: 1,
				iterationsCompleted: 1,
				stepsExecuted: 6_000,
				passed: 5_990,
				failed: 10,
				skipped: 0,
				errored: 0,
				stepsStored: 1,
				stepsDropped: 5_999,
			},
		});

		render(<ScenarioRunView run={RUN} />);

		// Tally the rows and this reads "0 passed" beside a header claiming
		// 6,000 steps.
		expect(outcomeCount("passed")).toContain("5990");
		expect(outcomeCount("failed")).toContain("10");
	});

	it("falls back to the streaming rows while the run has no report yet", () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			store.addSteps([
				{
					iteration: 0,
					stepIndex: 0,
					name: "Log in",
					outcome: "passed",
					statusCode: 200,
					latencyMs: 40,
				},
			]);
		});

		// The report's totals are the truth once it exists; until then the only
		// evidence is what has streamed, and four zeros would be wrong.
		expect(outcomeCount("passed")).toContain("1");
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
			store.addSteps([
				{
					iteration: 0,
					stepIndex: 0,
					name: "In flight",
					outcome: "passed",
					statusCode: 200,
					latencyMs: 5,
				},
			]);
		});

		fireEvent.click(screen.getByText("In flight").closest("button")!);

		expect(screen.queryByTestId("response-body")).toBeNull();
		// Not an empty panel, though: an accordion that opens onto nothing at
		// all reads as a broken app rather than as a step whose exchange has
		// not been written yet, which is what it is.
		expect(screen.getByText(/once the run finishes/i)).toBeTruthy();
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

	it("names the data row an iteration bound, beside the iteration", () => {
		// Two iterations over one row: the numbers disagree, which is exactly
		// what the row label is for - "Iteration 2" alone cannot say that this
		// pass re-used row 1.
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "passed", { name: "Only step", dataRowIndex: 0 }),
				storedStep(1, 0, "passed", { name: "Only step", dataRowIndex: 0 }),
			],
		});

		render(<ScenarioRunView run={RUN} />);

		expect(screen.getAllByText("Iteration 1 · Row 1")).toHaveLength(1);
		expect(screen.getAllByText("Iteration 2 · Row 1")).toHaveLength(1);
	});

	it("says nothing about a data row for a run that had none", () => {
		reportQuery.data = report({
			results: [
				storedStep(0, 0, "passed", { name: "Only step" }),
				storedStep(1, 0, "passed", { name: "Only step" }),
			],
		});

		render(<ScenarioRunView run={RUN} />);

		expect(screen.queryByText(/Row/)).toBeNull();
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

describe("stored-exchange disclosure", () => {
	// Issue #731. The Data tab says a data file's "rows are never saved
	// anywhere", which is true of the file and the contract and false of every
	// cell that reached a request - the step rows below hold those requests.
	it("discloses that the listed steps hold their exchanges", () => {
		reportQuery.data = report({ results: [storedStep(0, 0, "passed", { name: "Log in" })] });

		render(<ScenarioRunView run={RUN} />);

		expect(screen.getByText(/stored step data/i)).toBeTruthy();
	});

	it("names the bound rows when the run had a data file", () => {
		reportQuery.data = report({
			results: [storedStep(0, 0, "passed", { name: "Log in", dataRowIndex: 0 })],
		});

		render(<ScenarioRunView run={RUN} />);

		const notice = screen.getByText(/stored step data/i).closest("div")!;
		expect(notice.textContent).toContain("bound a data file");
	});

	it("says nothing about a data file for a run that bound none", () => {
		reportQuery.data = report({ results: [storedStep(0, 0, "passed", { name: "Log in" })] });

		render(<ScenarioRunView run={RUN} />);

		const notice = screen.getByText(/stored step data/i).closest("div")!;
		expect(notice.textContent).not.toContain("bound a data file");
	});

	it("discloses a live run's steps before its rows are written", () => {
		// The engine batches step rows to SQLite when the run ends, so a reader
		// watching a run stream is exactly the reader who has not yet seen what
		// gets kept. Reading the flag off the report instead of the steps would
		// leave this case silent.
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);
		act(() => {
			const store = useScenarioRunStore.getState();
			store.startRun("run-1");
			store.addSteps([
				{
					iteration: 0,
					stepIndex: 0,
					name: "In flight",
					outcome: "passed",
					statusCode: 200,
					latencyMs: 5,
					dataRowIndex: 0,
				},
			]);
		});

		const notice = screen.getByText(/stored step data/i).closest("div")!;
		expect(notice.textContent).toContain("bound a data file");
	});

	it("stays silent on a run with no steps to disclose", () => {
		reportQuery.data = report({ results: [] });

		render(<ScenarioRunView run={RUN} />);

		expect(screen.queryByText(/stored step data/i)).toBeNull();
	});
});

describe("stopping a live run", () => {
	it("stops the run this tab is streaming", async () => {
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);
		act(() => {
			useScenarioRunStore.getState().startRun("run-1");
		});

		await act(async () => {
			fireEvent.click(stopButton()!);
		});

		expect(stopRun).toHaveBeenCalledWith("run-1");
	});

	it("stops a running run this tab never attached a stream to", async () => {
		// The relaunch case: the engine is still executing, the tab was reopened
		// from History, and there is no stream to read "live" from. Gate the
		// control on the stream alone and this run becomes uncancellable -
		// which is the case the issue is actually about.
		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);

		expect(useScenarioRunStore.getState().isStreaming).toBe(false);
		await act(async () => {
			fireEvent.click(stopButton()!);
		});

		expect(stopRun).toHaveBeenCalledWith("run-1");
	});

	it("offers nothing to stop once the run is terminal", () => {
		reportQuery.data = report({ results: [storedStep(0, 0, "passed", { name: "Done" })] });

		render(<ScenarioRunView run={{ ...RUN, status: "completed" }} />);

		expect(stopButton()).toBeNull();
	});

	it("disables itself and says so while the stop is in flight", async () => {
		let settle: () => void = () => {};
		stopRun.mockImplementation(
			() =>
				new Promise<unknown>((resolve) => {
					settle = () => resolve({});
				})
		);

		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);
		fireEvent.click(stopButton()!);

		// A second click while the first is unanswered would send a second stop.
		const pending = stopButton()!;
		expect(pending.textContent).toContain("Stopping");
		expect((pending as HTMLButtonElement).disabled).toBe(true);

		await act(async () => {
			settle();
		});
	});

	it("reports a failed stop as a retryable toast rather than silently", async () => {
		stopRun.mockRejectedValue(new Error("Engine unreachable"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		render(<ScenarioRunView run={{ ...RUN, status: "running" }} />);
		await act(async () => {
			fireEvent.click(stopButton()!);
		});

		await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
		const toast = useToastStore.getState().toasts[0];
		expect(toast.variant).toBe("error");
		expect(toast.message).toContain("Engine unreachable");

		// The run is still sending requests, so the retry is the point of the
		// toast - not the message.
		stopRun.mockResolvedValue({});
		await act(async () => {
			toast.action!.onClick();
		});
		expect(stopRun).toHaveBeenCalledTimes(2);

		// And the button is back, so the failure did not leave the tab stuck on
		// "Stopping…" with nothing to click.
		expect((stopButton() as HTMLButtonElement).disabled).toBe(false);
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
