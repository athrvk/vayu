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
 * The run-report pane's three non-content answers.
 *
 * Loading was a bare spinner - the only pane in the app still using one after
 * `DetailSkeleton` landed, so the report header jumped into place instead of
 * resolving into a shape that was already there.
 *
 * The error pane was worse than plain: its single action, "Back to History",
 * walked the user *away* from the run. A transient engine hiccup therefore had
 * no recovery short of re-selecting the run from the drawer, even though the
 * query it failed on exposes a `refetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import HistoryDetail from "./HistoryDetail";
import { useTabsStore } from "@/stores";
import { formatInstant } from "@/lib/time-value";

const refetch = vi.fn();
const collections: { id: string; name: string }[] = [];
const refetchRun = vi.fn();
const useRunReportQuery = vi.fn();
const reportQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch,
};
/*
 * The run itself, not only its report. A design run's configuration exists
 * nowhere else - the report has no `metadata.configuration` for one - so the
 * pane fetches both and asks for the report only when the run is a load run.
 */
const runQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch: refetchRun,
};

// `isRunNotFound` is the real one: the pane's whole job here is to discriminate
// a deletion from a transport failure, and a stubbed predicate would assert
// nothing about that.
vi.mock("@/queries", async () => {
	const runs = await vi.importActual<typeof import("@/queries/runs")>("@/queries/runs");
	return {
		useRunQuery: () => runQuery,
		useRunReportQuery: (...args: unknown[]) => {
			useRunReportQuery(...args);
			return reportQuery;
		},
		isRunNotFound: runs.isRunNotFound,
		useCollectionsQuery: () => ({ data: collections }),
	};
});

// The detail routers render heavy chart trees that are irrelevant here; the
// question is only which of the three panes HistoryDetail chooses.
//
// Each stub holds one piece of local state, as the real views do (an active
// tab, a filter), and shows it in `data-picked`: a pane that is re-used across
// runs keeps the pick, a remounted one starts back at "none".
async function statefulView(testId: string) {
	const { useState } = await import("react");
	function StatefulView() {
		const [picked, setPicked] = useState("none");
		return (
			<button
				type="button"
				data-testid={testId}
				data-picked={picked}
				onClick={() => setPicked("steps")}
			>
				view
			</button>
		);
	}
	return { default: StatefulView };
}
vi.mock("./LoadTestDetail", () => statefulView("load-test-detail"));
vi.mock("./DesignRunView", () => statefulView("design-run-view"));
vi.mock("./ScenarioRunView", () => statefulView("scenario-run-view"));

beforeEach(() => {
	refetch.mockClear();
	refetchRun.mockClear();
	useRunReportQuery.mockClear();
	collections.length = 0;
	reportQuery.data = undefined;
	reportQuery.isLoading = false;
	reportQuery.error = null;
	// A settled load run by default, so each test varies only what it is about.
	runQuery.data = { id: "run-1", type: "load", status: "completed" };
	runQuery.isLoading = false;
	runQuery.error = null;
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "run", entityId: "run-1", title: "Run" } as never],
		activeTabId: "t1",
	});
});

describe("HistoryDetail loading", () => {
	it("shows the detail skeleton, not a spinner", () => {
		reportQuery.isLoading = true;
		render(<HistoryDetail />);

		// role=status + a label naming the pane is DetailSkeleton's contract.
		expect(screen.getByRole("status", { name: /loading run report/i })).toBeTruthy();
	});
});

describe("HistoryDetail error", () => {
	it("offers a retry that refetches, instead of only walking the user away", () => {
		runQuery.error = new Error("engine unreachable");
		runQuery.data = undefined;
		render(<HistoryDetail />);

		expect(screen.getByText(/couldn't load this run/i)).toBeTruthy();
		// The raw reason is worth showing in a developer tool: "failed to fetch"
		// and a 500 lead to different next steps.
		expect(screen.getByText(/engine unreachable/i)).toBeTruthy();

		const retry = screen.getByRole("button", { name: /try again/i });
		fireEvent.click(retry);
		expect(refetchRun).toHaveBeenCalledTimes(1);
	});

	/*
	 * A run tab outlives its run: tabs are persisted, so a run deleted in
	 * another window - or before the last quit - rehydrates into this pane on
	 * launch. Retrying a 404 can only 404 again, which is what the global
	 * `retry: 2` had it doing; the way out is closing the tab.
	 */
	it("says the run is gone and offers the tab close, with no doomed retry", async () => {
		const { RunNotFoundError } = await import("@/queries/runs");
		runQuery.error = new RunNotFoundError("run-1");
		runQuery.data = undefined;
		render(<HistoryDetail />);

		expect(screen.getByText(/this run no longer exists/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /close tab/i }));
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("treats a settled-but-empty report as an error, not as content", () => {
		// The query resolves `undefined` with no error when the run is gone.
		// Falling through to a detail view would render a report that isn't there.
		render(<HistoryDetail />);

		expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
		expect(screen.queryByTestId("load-test-detail")).toBeNull();
	});
});

describe("HistoryDetail routing", () => {
	it("renders the detached copy for a design run, and never asks for a report", () => {
		runQuery.data = { id: "run-1", type: "design", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByTestId("design-run-view")).toBeTruthy();
		// The report is a load-test aggregate. A design run must not be gated on
		// one - `reportQuery.data` is undefined here, which used to mean "error".
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("renders the load-test report for a load run", () => {
		reportQuery.data = { metadata: { runType: "load" } };

		render(<HistoryDetail />);

		expect(screen.getByTestId("load-test-detail")).toBeTruthy();
	});

	/*
	 * A scenario run's `results[]` are step executions of different requests, so
	 * `LoadTestDetail`'s percentiles would describe a sequence as though it were
	 * one request repeated. It also must not be gated on the report the way a
	 * load run is: while the sequence is still executing, the live step stream
	 * is the content, and waiting for a report would hold the tab on a skeleton
	 * for the length of the run.
	 */
	it("renders the step list for a scenario run, not the load-test report", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByTestId("scenario-run-view")).toBeTruthy();
		expect(screen.queryByTestId("load-test-detail")).toBeNull();
	});

	it("does not gate a running scenario run on a report it has no reason to have", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "running" };
		reportQuery.data = undefined;
		reportQuery.error = new Error("no report yet");

		render(<HistoryDetail />);

		expect(screen.getByTestId("scenario-run-view")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("names a scenario run a collection run in the header", () => {
		runQuery.data = { id: "run-1", type: "scenario", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByText(/collection run/i)).toBeTruthy();
	});

	it("shows the run id and status without repeating the URL", () => {
		runQuery.data = { id: "run-1", type: "design", status: "completed" };

		render(<HistoryDetail />);

		expect(screen.getByText("run-1")).toBeTruthy();
		expect(screen.getByText("Completed")).toBeTruthy();
		// The builder below owns the URL bar; showing it here too was two of them.
		expect(screen.queryByText(/https:\/\//)).toBeNull();
	});

	/*
	 * The header badge reads the one status map the sidebar row and the
	 * dashboard header read (#1944), so a status is the same hue and word on
	 * every surface. It had been a hand-rolled Badge: a completed run as the
	 * accent-filled `default` variant, running and pending as a bare outline.
	 *
	 * Mutation check: put the old `Badge variant="default"` back for
	 * `completed` and the first assertion reddens on `bg-primary-fill`; draw
	 * `running` without `RunStatusGlyph` and the spinner assertion reddens.
	 */
	it.each([
		["completed", "Completed", "text-status-success-text"],
		["failed", "Failed", "text-status-error-text"],
		["stopped", "Stopped", "text-status-stopped-text"],
		["running", "Running", "text-status-running-text"],
		["pending", "Pending", "text-muted-foreground"],
	] as const)("draws a %s run as %s in its status family", (status, label, textClass) => {
		runQuery.data = { id: "run-1", type: "design", status };

		render(<HistoryDetail />);

		const pill = screen.getByText(label).closest("[data-status]");
		expect(pill).not.toBeNull();
		expect(pill!.getAttribute("data-status")).toBe(status);
		expect(pill!.className).toContain(textClass);
		expect(pill!.className).not.toContain("bg-primary-fill");
		const spinning = pill!.querySelector("svg")!.getAttribute("class") ?? "";
		expect(spinning.includes("animate-spin")).toBe(status === "running");
	});
});

/**
 * The report views keep local state (the load report's active tab, the
 * collection run's filters), so a pane that is not remounted on a run switch
 * carries the last run's picks into the next one - a Steps tab with no panel
 * left to show it, a blank pane (#2148).
 *
 * Mutation check: drop the `key` from a view and its case reddens.
 */
describe("HistoryDetail switching between runs", () => {
	function openRun(entityId: string) {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "run", entityId, title: "Run" } as never],
			activeTabId: "t1",
		});
	}

	it.each([
		["load", "load-test-detail"],
		["scenario", "scenario-run-view"],
		["design", "design-run-view"],
	])("starts a %s run's view afresh rather than reusing the last run's", (type, testId) => {
		runQuery.data = { id: "run-1", type, status: "completed" };
		reportQuery.data = { metadata: { runType: "load" } };
		const { rerender } = render(<HistoryDetail />);
		fireEvent.click(screen.getByTestId(testId));
		expect(screen.getByTestId(testId).getAttribute("data-picked")).toBe("steps");

		openRun("run-2");
		runQuery.data = { id: "run-2", type, status: "completed" };
		rerender(<HistoryDetail />);

		expect(screen.getByTestId(testId).getAttribute("data-picked")).toBe("none");
	});

	it("keeps the view's state while the same run re-renders", () => {
		reportQuery.data = { metadata: { runType: "load" } };
		const { rerender } = render(<HistoryDetail />);
		fireEvent.click(screen.getByTestId("load-test-detail"));

		rerender(<HistoryDetail />);

		expect(screen.getByTestId("load-test-detail").getAttribute("data-picked")).toBe("steps");
	});
});

/**
 * A load run the engine is still executing has a report, but it is the requests
 * so far, and cached as the tab's content it froze the pane on a half-finished
 * run (#1934). Both branches are asserted: a settled run still gets the report.
 */
describe("HistoryDetail load run in progress", () => {
	/*
	 * Mutation check: drop the `isLoadRunInProgress` branch (render
	 * `LoadTestDetail` unconditionally) and the in-progress cases redden.
	 */
	it.each(["running", "pending"])(
		"says a %s load run is in progress, with Stop, instead of a report",
		(status) => {
			runQuery.data = { id: "run-1", type: "load", status };
			// What the engine would hand back for a live run.
			reportQuery.data = { metadata: { runType: "load", status } };

			render(<HistoryDetail />);

			expect(screen.getByText(/this load test is still running/i)).toBeTruthy();
			expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
			expect(screen.queryByTestId("load-test-detail")).toBeNull();
		}
	);

	it("does not ask for the report while the run is in progress", () => {
		runQuery.data = { id: "run-1", type: "load", status: "running" };

		render(<HistoryDetail />);

		expect(useRunReportQuery).toHaveBeenLastCalledWith(null, "running");
	});

	it("does not gate the pane on a report the run cannot have yet", () => {
		runQuery.data = { id: "run-1", type: "load", status: "running" };
		reportQuery.data = undefined;
		reportQuery.error = new Error("no report yet");

		render(<HistoryDetail />);

		expect(screen.getByText(/this load test is still running/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it.each(["completed", "stopped", "failed"])(
		"renders the report for a %s load run, with no Stop",
		(status) => {
			runQuery.data = { id: "run-1", type: "load", status };
			reportQuery.data = { metadata: { runType: "load" } };

			render(<HistoryDetail />);

			expect(screen.getByTestId("load-test-detail")).toBeTruthy();
			expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
			expect(useRunReportQuery).toHaveBeenLastCalledWith("run-1", status);
		}
	);

	it("turns into the report when the run ends, without the tab being reopened", () => {
		runQuery.data = { id: "run-1", type: "load", status: "running" };
		const { rerender } = render(<HistoryDetail />);
		expect(screen.queryByTestId("load-test-detail")).toBeNull();

		// What the detail poll, or the close invalidation, delivers.
		runQuery.data = { id: "run-1", type: "load", status: "completed" };
		reportQuery.data = { metadata: { runType: "load" } };
		rerender(<HistoryDetail />);

		expect(screen.getByTestId("load-test-detail")).toBeTruthy();
		expect(screen.queryByText(/this load test is still running/i)).toBeNull();
	});
});

/**
 * The header names the run by what it ran, not by its type and id (#2270).
 *
 * The id was the title's neighbour in a mono face and the type was the title:
 * two runs of two requests read "Load test run_8f3a" and "Load test run_c01d",
 * so the pane could not be told from the tab strip's identical-looking
 * neighbour. The id is now a small copyable detail, the start time sits by the
 * status, and the comment the user wrote at launch is read under the title.
 *
 * Layout (that the title truncates, the detail line sits under it) is not
 * unit-testable: jsdom has no layout. These pin the content and the wiring.
 *
 * Mutation check: render `RUN_TYPE_NAME[run.type]` in the `h1` again and the
 * name and collection cases redden; drop the `DEFAULT_REQUEST_NAME` test in
 * `runTitle` and the default-name case reddens; hand `RunComment` the
 * `summary` alone and the snapshot case reddens.
 */
describe("HistoryDetail header", () => {
	const START = 1_750_000_000_000;
	const title = () => screen.getByRole("heading", { level: 1 }).textContent;

	function openRun(run: Record<string, unknown>) {
		runQuery.data = {
			id: "run-1",
			type: "design",
			status: "completed",
			startTime: START,
			...run,
		};
		// What a settled load run needs; a design run never asks.
		reportQuery.data = { metadata: { runType: "load" } };
		render(<HistoryDetail />);
	}

	it("titles a run with the request's name, not its type or id", () => {
		openRun({ configSnapshot: { requestName: "Create order" } });

		expect(title()).toBe("Create order");
		expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("run-1");
	});

	it("still says what kind of run it is, beside the id", () => {
		openRun({ type: "load", configSnapshot: { requestName: "Create order" } });

		expect(screen.getByText(/Load test\s*·/)).toBeTruthy();
	});

	it("reads the name off a list row's summary when there is no snapshot", () => {
		openRun({ summary: { requestName: "From the list" } });

		expect(title()).toBe("From the list");
	});

	it.each(["New Request", "   ", ""])("ignores the placeholder name %j", (requestName) => {
		openRun({ configSnapshot: { requestName } });

		expect(title()).toBe("Send");
	});

	it("falls back to the run type, once, when nothing names the run", () => {
		openRun({ type: "load" });

		expect(title()).toBe("Load test");
		// The type is the title; repeating it beside the id would say it twice.
		expect(screen.getAllByText(/Load test/)).toHaveLength(1);
	});

	it("titles a collection run with its collection's name", () => {
		collections.push({ id: "col_1", name: "Checkout" });
		openRun({ type: "scenario", configSnapshot: { scenario: { collectionId: "col_1" } } });

		expect(title()).toBe("Checkout");
	});

	it("titles a collection load run (type load) with its collection too", () => {
		collections.push({ id: "col_1", name: "Checkout" });
		openRun({ type: "load", configSnapshot: { scenario: { collectionId: "col_1" } } });

		expect(title()).toBe("Checkout");
	});

	it("names a collection run by its id once the collection is gone, never blank", () => {
		openRun({ type: "scenario", configSnapshot: { scenario: { collectionId: "col_gone" } } });

		expect(title()).toBe("col_gone");
	});

	it("keeps the request's name over the collection's", () => {
		collections.push({ id: "col_1", name: "Checkout" });
		openRun({
			type: "scenario",
			configSnapshot: { requestName: "Nightly", scenario: { collectionId: "col_1" } },
		});

		expect(title()).toBe("Nightly");
	});

	it("shows when the run started through the time card", () => {
		openRun({});

		const time = document.querySelector("time");
		expect(time?.getAttribute("datetime")).toBe(new Date(START).toISOString());
		expect(time?.textContent).toBe(formatInstant(START, "datetime"));
	});

	describe("the run id", () => {
		const writeText = vi.fn();
		const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

		beforeEach(() => {
			writeText.mockReset().mockResolvedValue(undefined);
			Object.defineProperty(navigator, "clipboard", {
				value: { writeText },
				configurable: true,
			});
		});
		afterEach(() => {
			if (original) Object.defineProperty(navigator, "clipboard", original);
			else Reflect.deleteProperty(navigator, "clipboard");
		});

		it("is a mono detail, not the title", () => {
			openRun({ configSnapshot: { requestName: "Create order" } });

			const id = screen.getByText("run-1");
			expect(id.className).toContain("font-mono");
			expect(screen.getByRole("heading", { level: 1 }).contains(id)).toBe(false);
		});

		it("is copied by a button with an accessible name", async () => {
			openRun({});

			fireEvent.click(screen.getByRole("button", { name: "Copy run ID" }));

			await waitFor(() => expect(writeText).toHaveBeenCalledWith("run-1"));
		});
	});

	describe("the comment", () => {
		it("is labelled Comment and sits with the header, under the title", () => {
			openRun({
				configSnapshot: { requestName: "Create order", comment: "after the cache fix" },
			});

			const comment = screen.getByText("after the cache fix").closest("p");
			expect(within(comment!).getByText("Comment")).toBeTruthy();
			const header = screen.getByRole("heading", { level: 1 }).closest("div.border-b");
			expect(header?.contains(comment)).toBe(true);
		});

		it("is read from the list row's summary when the snapshot has none", () => {
			openRun({ summary: { comment: "from the row" } });

			expect(screen.getByText("from the row")).toBeTruthy();
		});

		it.each([undefined, "", "   "])("is absent, with no empty label, for %j", (comment) => {
			openRun({ configSnapshot: { comment } });

			expect(screen.queryByText("Comment")).toBeNull();
		});
	});
});
