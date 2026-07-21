/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run row has to say what was run.
 *
 * Without it the list read "Load · Completed · 2 hours ago" five times over,
 * with nothing distinguishing one row from the next — the only way to find out
 * which run was which was to open it.
 *
 * The identifier is the method and URL from `configSnapshot`, not the request's
 * name: runs store no name, and `requestId` is set only for design runs, so
 * every load test would have nothing to look up.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecentRuns } from "./RecentRuns";
import { useTabsStore } from "@/stores";
import type { Run } from "@/types";

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run-1",
		type: "load",
		status: "completed",
		startTime: Date.now() - 60_000,
		endTime: Date.now(),
		configSnapshot: { url: "http://localhost:8080/fast", method: "GET" },
		...over,
	} as Run;
}

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("RecentRuns", () => {
	it("shows what was run, not just when", () => {
		render(<RecentRuns runs={[run()]} />);
		expect(screen.getByText("http://localhost:8080/fast")).toBeInTheDocument();
		expect(screen.getByText("GET")).toBeInTheDocument();
	});

	it("tells two runs apart", () => {
		// The whole point: before this, both rows rendered identically.
		render(
			<RecentRuns
				runs={[
					run({
						id: "a",
						configSnapshot: { url: "https://api.test/one", method: "GET" },
					}),
					run({
						id: "b",
						startTime: Date.now() - 120_000,
						configSnapshot: { url: "https://api.test/two", method: "POST" },
					}),
				]}
			/>
		);
		expect(screen.getByText("https://api.test/one")).toBeInTheDocument();
		expect(screen.getByText("https://api.test/two")).toBeInTheDocument();
	});

	it("names the row for assistive tech, including the URL", () => {
		render(<RecentRuns runs={[run()]} />);
		expect(
			screen.getByRole("button", {
				name: /Open load test run, http:\/\/localhost:8080\/fast, completed/i,
			})
		).toBeInTheDocument();
	});

	it("says so rather than rendering a blank row when no URL was recorded", () => {
		// `configSnapshot` is optional on the type and absent on older runs; a
		// bare row would read as a rendering failure.
		render(<RecentRuns runs={[run({ configSnapshot: undefined })]} />);
		expect(screen.getByText(/No URL recorded/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Open load test run/i })).toBeInTheDocument();
	});

	it("still opens the run when the row is clicked", () => {
		render(<RecentRuns runs={[run({ id: "run-42" })]} />);
		screen.getByRole("button", { name: /Open load test run/i }).click();
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run-42",
		});
	});

	it("renders nothing when there are no runs", () => {
		const { container } = render(<RecentRuns runs={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});
