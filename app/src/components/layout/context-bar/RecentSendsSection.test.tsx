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
 * The section exists to say what the response pane cannot: more than one send.
 * So the first case below is the load-bearing one - several rows, in recency
 * order, each with its own status and latency. Cut it back to the latest send
 * and it is the "last result" section that was built and removed in #344.
 *
 * Mutation-checks: drop `resultSummary` from the row rendering and the status
 * and latency assertions redden; render the runs in the order received without
 * relying on the engine's `start_time DESC` and the ordering case still passes
 * (the engine sorts, this does not re-sort), which is why that case asserts the
 * order it was handed rather than a sort of its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { RecentSendsSection } from "./RecentSendsSection";
import { useTabsStore } from "@/stores";
import type { Run, RunListResponse } from "@/types";

let response: RunListResponse | undefined;
let loading = false;
const listRuns = vi.fn();

vi.mock("@/queries", () => ({
	useRecentDesignRunsQuery: (requestId: string | null | undefined) => {
		listRuns(requestId);
		return { data: response, isLoading: loading };
	},
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const run = (id: string, extra: Partial<Run> = {}): Run => ({
	id,
	type: "design",
	status: "completed",
	startTime: Date.now(),
	endTime: Date.now(),
	requestId: "req_1",
	...extra,
});

const envelope = (runs: Run[]): RunListResponse => ({
	data: runs,
	pagination: {
		total: runs.length,
		limit: 5,
		offset: 0,
		hasMore: false,
		returned: runs.length,
	},
});

beforeEach(() => {
	response = undefined;
	loading = false;
	listRuns.mockClear();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("RecentSendsSection", () => {
	it("shows several sends, newest first, each with its own status and latency", () => {
		response = envelope([
			run("run_3", { resultSummary: { statusCode: 500, latencyMs: 812 } }),
			run("run_2", { resultSummary: { statusCode: 200, latencyMs: 34 } }),
			run("run_1", { resultSummary: { statusCode: 200, latencyMs: 29 } }),
		]);
		render(<RecentSendsSection tab={TAB} />);

		const rows = screen.getAllByRole("button");
		expect(rows).toHaveLength(3);
		// The order the engine handed over (start_time DESC) is the order shown.
		expect(within(rows[0]).getByText("500")).toBeInTheDocument();
		expect(within(rows[0]).getByText("812 ms")).toBeInTheDocument();
		expect(within(rows[1]).getByText("200")).toBeInTheDocument();
		expect(within(rows[1]).getByText("34 ms")).toBeInTheDocument();
		expect(within(rows[2]).getByText("29 ms")).toBeInTheDocument();
	});

	it("opens the run in a History tab, leaving the request tab open", () => {
		response = envelope([run("run_1", { resultSummary: { statusCode: 200, latencyMs: 12 } })]);
		render(<RecentSendsSection tab={TAB} />);

		fireEvent.click(screen.getByRole("button"));

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => [t.type, t.entityId])).toEqual([["run", "run_1"]]);
	});

	it("says a send is in flight rather than reporting it as a status-0 failure", () => {
		// A run with no stored result is not a run that failed: `statusCode: 0`
		// is the wire's word for "reached no server", and using it here would
		// report a send that has not finished as one that did, badly.
		response = envelope([run("run_1", { status: "running" })]);
		render(<RecentSendsSection tab={TAB} />);

		expect(screen.getByText("Sending…")).toBeInTheDocument();
		expect(screen.queryByText("0")).not.toBeInTheDocument();
	});

	it("says a terminal run with no stored result has none", () => {
		response = envelope([run("run_1", { status: "failed" })]);
		render(<RecentSendsSection tab={TAB} />);

		expect(screen.getByText("No result")).toBeInTheDocument();
	});

	it("says the request has not been sent yet rather than showing an empty list", () => {
		response = envelope([]);
		render(<RecentSendsSection tab={TAB} />);

		expect(screen.getByText("This request has not been sent yet")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the loading line only while there is nothing to show", () => {
		loading = true;
		render(<RecentSendsSection tab={TAB} />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();

		// A refetch behind an already-loaded list must not blank it out - the
		// section refetches after every send.
		response = envelope([run("run_1", { resultSummary: { statusCode: 200, latencyMs: 12 } })]);
		render(<RecentSendsSection tab={TAB} />);
		expect(screen.getByText("200")).toBeInTheDocument();
	});

	it("asks for the runs of the tab's own request", () => {
		response = envelope([]);
		render(<RecentSendsSection tab={TAB} />);
		expect(listRuns).toHaveBeenCalledWith("req_1");
	});
});
