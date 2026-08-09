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
 * The section says how the collection's last run went and offers the way back
 * to it. The load-bearing cases are the two the deferral was about: it asks for
 * *this* collection's runs (the filter is the whole reason the section can
 * exist), and it reads the row it was handed rather than fetching a report.
 *
 * Mutation-checks: drop the status branch and the "Failed" case reddens; drop
 * `run.summary.scenario` from the size label and the steps case reddens; hand
 * `useLastCollectionRunQuery` the wrong id and the last case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CollectionLastRunSection } from "./CollectionLastRunSection";
import { scenarioSizeLabel } from "./collection-last-run";
import { useTabsStore } from "@/stores";
import type { Run, RunListResponse } from "@/types";

let response: RunListResponse | undefined;
let loading = false;
const lastCollectionRun = vi.fn();

vi.mock("@/queries", () => ({
	useLastCollectionRunQuery: (collectionId: string | null | undefined) => {
		lastCollectionRun(collectionId);
		return { data: response, isLoading: loading };
	},
}));

const TAB = { id: "t1", type: "collection", entityId: "col_1" } as const;

const run = (id: string, extra: Partial<Run> = {}): Run => ({
	id,
	type: "scenario",
	status: "completed",
	startTime: Date.now(),
	endTime: Date.now(),
	summary: { scenario: { collectionId: "col_1", stepCount: 3, iterations: 1 } },
	...extra,
});

const envelope = (runs: Run[]): RunListResponse => ({
	data: runs,
	pagination: {
		total: runs.length,
		limit: 1,
		offset: 0,
		hasMore: false,
		returned: runs.length,
	},
});

beforeEach(() => {
	response = undefined;
	loading = false;
	lastCollectionRun.mockClear();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("CollectionLastRunSection", () => {
	it("shows the outcome and the size of the last run", () => {
		response = envelope([run("run_1")]);
		render(<CollectionLastRunSection tab={TAB} />);

		expect(screen.getByText("Completed")).toBeInTheDocument();
		expect(screen.getByText("3 steps")).toBeInTheDocument();
	});

	it("says a run failed, in the status colour that means it", () => {
		// The failure is the one worth surfacing, which is why the query does not
		// filter to completed runs - see useLastCollectionRunQuery.
		response = envelope([run("run_1", { status: "failed" })]);
		render(<CollectionLastRunSection tab={TAB} />);

		const label = screen.getByText("Failed");
		expect(label).toBeInTheDocument();
		expect(label.className).toContain("text-status-error-text");
	});

	it("says a run is still going rather than calling it an outcome", () => {
		response = envelope([run("run_1", { status: "running" })]);
		render(<CollectionLastRunSection tab={TAB} />);

		expect(screen.getByText("Running")).toBeInTheDocument();
		expect(screen.queryByText("Completed")).not.toBeInTheDocument();
	});

	it("opens the run in a History tab, leaving the collection tab open", () => {
		response = envelope([run("run_1")]);
		render(<CollectionLastRunSection tab={TAB} />);

		fireEvent.click(screen.getByRole("button"));

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => [t.type, t.entityId])).toEqual([["run", "run_1"]]);
	});

	it("says the collection has not been run yet rather than showing a blank row", () => {
		response = envelope([]);
		render(<CollectionLastRunSection tab={TAB} />);

		expect(screen.getByText("This collection has not been run yet")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the loading line only while there is nothing to show", () => {
		loading = true;
		render(<CollectionLastRunSection tab={TAB} />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();

		// A refetch behind an already-loaded row must not blank it out - the
		// section refetches after every collection run.
		response = envelope([run("run_1")]);
		render(<CollectionLastRunSection tab={TAB} />);
		expect(screen.getByText("Completed")).toBeInTheDocument();
	});

	it("asks for the runs of the tab's own collection", () => {
		// The filtered query is the whole reason this section can exist: without
		// `collectionId` the only route to this row was a scan of every snapshot.
		response = envelope([]);
		render(<CollectionLastRunSection tab={TAB} />);
		expect(lastCollectionRun).toHaveBeenCalledWith("col_1");
	});
});

describe("scenarioSizeLabel", () => {
	it("counts the steps, and the passes only when there was more than one", () => {
		expect(scenarioSizeLabel(run("r", { summary: { scenario: { stepCount: 1 } } }))).toBe(
			"1 step"
		);
		expect(
			scenarioSizeLabel(run("r", { summary: { scenario: { stepCount: 4, iterations: 1 } } }))
		).toBe("4 steps");
		expect(
			scenarioSizeLabel(run("r", { summary: { scenario: { stepCount: 4, iterations: 3 } } }))
		).toBe("4 steps × 3");
	});

	it("has nothing to say about a run whose plan length was never recorded", () => {
		// A run stored before the engine sent the descriptor. "0 steps" would be
		// a claim about the plan; the honest answer is silence.
		expect(scenarioSizeLabel(run("r", { summary: {} }))).toBeNull();
		expect(scenarioSizeLabel(run("r", { summary: undefined }))).toBeNull();
	});
});
