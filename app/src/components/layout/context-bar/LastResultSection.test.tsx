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
 * How this request last went.
 *
 * The exchange lives on the run *report*'s one result row, not on the run list
 * row - the same path the builder's cold-start restore reads. Reading it off
 * the list row instead renders an empty state for a request that has been sent,
 * which looks like "never sent" rather than like a bug.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LastResultSection } from "./LastResultSection";
import type { RunReport } from "@/types";

// Only `results` is read here; typing the fixture to that keeps an empty list
// from needing a cast through the report's summary/latency/statusCodes fields,
// none of which this section touches.
let lastRun: {
	run: { id: string; startTime: number } | null;
	report: Pick<RunReport, "results"> | undefined;
	isLoading: boolean;
};

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: "col_1" } }),
	useLastDesignRunQuery: () => lastRun,
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

const renderSection = () => render(<LastResultSection tab={TAB} />);

beforeEach(() => {
	lastRun = {
		run: { id: "run_1", startTime: Date.now() - 60_000 },
		report: {
			results: [
				{
					timestamp: Date.now() - 60_000,
					statusCode: 201,
					statusText: "Created",
					latencyMs: 42.6,
				},
			],
		},
		isLoading: false,
	};
});

describe("LastResultSection", () => {
	it("shows the status, the duration and when", () => {
		renderSection();

		expect(screen.getByText(/201/)).toBeInTheDocument();
		// Rounded: a snippet of a duration to one decimal place is noise at this
		// size, and 42.6 renders as "43 ms".
		expect(screen.getByText("43 ms")).toBeInTheDocument();
		expect(screen.getByText(/ago|just now/i)).toBeInTheDocument();
	});

	it("renders a clean empty state before the first send", () => {
		lastRun = { run: null, report: undefined, isLoading: false };
		renderSection();
		expect(screen.getByText("This request hasn't been sent yet")).toBeInTheDocument();
	});

	it("renders the empty state when a run exists but its report carries no result", () => {
		lastRun = { ...lastRun, report: { results: [] } };
		renderSection();
		expect(screen.getByText("This request hasn't been sent yet")).toBeInTheDocument();
	});

	it("surfaces the failure text when the send failed", () => {
		lastRun = {
			...lastRun,
			report: {
				results: [
					{
						timestamp: Date.now(),
						statusCode: 0,
						latencyMs: 0,
						error: "Connection refused",
					},
				],
			},
		};
		renderSection();
		// Written and never read is this repo's most repeated defect; `error` has
		// a reader here.
		expect(screen.getByText("Connection refused")).toBeInTheDocument();
	});

	it("says nothing while it is still loading", () => {
		lastRun = { run: null, report: undefined, isLoading: true };
		renderSection();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});
