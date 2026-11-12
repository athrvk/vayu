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
 * A run row has to say what was run.
 *
 * Without it the list read "Load · Completed · 2 hours ago" five times over,
 * with nothing distinguishing one row from the next - the only way to find out
 * which run was which was to open it.
 *
 * The identifier is the method and URL from the run `summary` (the compact list
 * row), not the request's name: runs store no name, and `requestId` is set only
 * for design runs, so every load test would have nothing to look up.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { RecentRuns } from "./RecentRuns";
import { useTabsStore } from "@/stores";
import type { Collection, Run } from "@/types";
import { RUN_TYPE_NAME } from "@/modules/history/types";

let collections: Pick<Collection, "id" | "name">[] = [];

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections }),
}));

function run(over: Partial<Run> = {}): Run {
	return {
		id: "run-1",
		type: "load",
		status: "completed",
		startTime: Date.now() - 60_000,
		endTime: Date.now(),
		summary: { url: "http://localhost:8080/fast", method: "GET" },
		...over,
	} as Run;
}

/** A collection run's list row: no URL, no method, the collection by id, and the step counts. */
function collectionRun(over: Partial<Run> = {}): Run {
	return run({
		type: "scenario",
		summary: { scenario: { collectionId: "col_1", stepCount: 33, iterations: 1 } },
		resultSummary: { passed: 27, failed: 6 },
		...over,
	} as Partial<Run>);
}

beforeEach(() => {
	collections = [{ id: "col_1", name: "Smoke suite" }];
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("RecentRuns", () => {
	it("shows what was run, not just when", () => {
		render(<RecentRuns runs={[run()]} />);
		expect(screen.getByText("http://localhost:8080/fast")).toBeInTheDocument();
		expect(screen.getByText("GET")).toBeInTheDocument();
	});

	it.each([
		["design", "Send"],
		["scenario", "Collection run"],
		["load", "Load test"],
	] as const)("names a %s run's kind %s", (type, name) => {
		render(<RecentRuns runs={[run({ type })]} />);
		expect(screen.getByText(name)).toBeInTheDocument();
	});

	it("tells two runs apart", () => {
		// The whole point: before this, both rows rendered identically.
		render(
			<RecentRuns
				runs={[
					run({
						id: "a",
						summary: { url: "https://api.test/one", method: "GET" },
					}),
					run({
						id: "b",
						startTime: Date.now() - 120_000,
						summary: { url: "https://api.test/two", method: "POST" },
					}),
				]}
			/>
		);
		expect(screen.getByText("https://api.test/one")).toBeInTheDocument();
		expect(screen.getByText("https://api.test/two")).toBeInTheDocument();
	});

	it.each(["design", "scenario", "load"] as const)(
		"names a %s row by RUN_TYPE_NAME in its chip and its accessible name",
		(type) => {
			render(<RecentRuns runs={[run({ type, summary: undefined })]} />);
			const name = RUN_TYPE_NAME[type];

			const row = screen.getByRole("button", { name: `Open ${name}, completed` });
			expect(row).toHaveTextContent(name);
			expect(row.getAttribute("aria-label")).not.toMatch(
				/request|scenario|collection(?! run)/i
			);
		}
	);

	it("names the row for assistive tech, including the URL", () => {
		render(<RecentRuns runs={[run()]} />);
		expect(
			screen.getByRole("button", {
				name: /Open Load test, http:\/\/localhost:8080\/fast, completed/i,
			})
		).toBeInTheDocument();
	});

	it("says so rather than rendering a blank row when no URL was recorded", () => {
		// `summary` is optional on the type and absent on older runs; a bare row
		// would read as a rendering failure.
		render(<RecentRuns runs={[run({ summary: undefined })]} />);
		expect(screen.getByText(/No URL recorded/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Open Load test/i })).toBeInTheDocument();
	});

	it("still opens the run when the row is clicked", () => {
		render(<RecentRuns runs={[run({ id: "run-42" })]} />);
		screen.getByRole("button", { name: /Open Load test/i }).click();
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({
			type: "run",
			entityId: "run-42",
		});
	});

	it("paints a terminal run status from the --status-* family", () => {
		// #1225. The same three words the history sidebar's `RunItem` paints, in
		// the same tokens: a run status is what `--status-*` is for, and the two
		// lists disagreeing was the drift. "Stopped" is the visible half - it was
		// the general amber and is now the family's orange, which is also what
		// this run's own left-bar (`--status-stopped`) has always been.
		render(
			<RecentRuns
				runs={[
					run({ id: "c", status: "completed" }),
					run({ id: "s", status: "stopped", startTime: Date.now() - 120_000 }),
					run({ id: "f", status: "failed", startTime: Date.now() - 180_000 }),
				]}
			/>
		);

		expect([...screen.getByText("Completed").classList]).toContain("text-status-success-text");
		expect([...screen.getByText("Stopped").classList]).toContain("text-status-stopped-text");
		expect([...screen.getByText("Failed").classList]).toContain("text-status-error-text");
	});

	it("names no status for a run still in flight", () => {
		// The status text is for what happened. `RUN_STATUS` has a word for
		// running and pending; deriving the label from it must not start listing them.
		render(
			<RecentRuns
				runs={[
					run({ id: "r", status: "running" }),
					run({ id: "p", status: "pending", startTime: Date.now() - 120_000 }),
				]}
			/>
		);

		expect(screen.queryByText("Running")).not.toBeInTheDocument();
		expect(screen.queryByText("Pending")).not.toBeInTheDocument();
		for (const row of screen.getAllByRole("button", { name: /Open Load test/i })) {
			expect(row.getAttribute("aria-label")).not.toMatch(/running|pending/i);
		}
	});

	describe("a collection run", () => {
		it("names the collection, with no method badge and no missing-URL line", () => {
			// A stray `method` on the summary must not draw a badge: the row's
			// work is a collection, which has no method.
			render(
				<RecentRuns
					runs={[
						collectionRun({
							summary: { method: "GET", scenario: { collectionId: "col_1" } },
						}),
					]}
				/>
			);

			const row = screen.getByRole("button", { name: /Open Collection run/ });
			expect(row).toHaveTextContent(RUN_TYPE_NAME.scenario);
			expect(screen.getByText("Smoke suite")).toBeInTheDocument();
			expect(screen.queryByText(/No URL recorded/i)).not.toBeInTheDocument();
			expect(screen.queryByText("GET")).not.toBeInTheDocument();
		});

		it("falls back to the collection id once the collection is gone", () => {
			collections = [];
			render(<RecentRuns runs={[collectionRun()]} />);
			expect(screen.getByText("col_1")).toBeInTheDocument();
		});

		it.each([
			["failed", { passed: 27, failed: 6 }],
			["errored", { passed: 27, errored: 2 }],
		] as const)(
			"reads in the error colour when a step %s, and says so in its name",
			(_, counts) => {
				render(
					<RecentRuns runs={[collectionRun({ resultSummary: counts } as Partial<Run>)]} />
				);

				const word = screen.getByText("Completed");
				expect([...word.classList]).toContain("text-status-error-text");
				expect([...word.classList]).not.toContain("text-status-success-text");
				expect(
					screen.getByRole("button", {
						name: "Open Collection run, Smoke suite, completed, verdict failed",
					})
				).toBeInTheDocument();
			}
		);

		it("stays green and states no verdict when every step passed", () => {
			render(
				<RecentRuns
					runs={[collectionRun({ resultSummary: { passed: 33 } } as Partial<Run>)]}
				/>
			);

			expect([...screen.getByText("Completed").classList]).toContain(
				"text-status-success-text"
			);
			expect(
				screen.getByRole("button", { name: "Open Collection run, Smoke suite, completed" })
			).toBeInTheDocument();
		});

		it("keeps a run's own failed status as the plain failure", () => {
			render(<RecentRuns runs={[collectionRun({ status: "failed" })]} />);
			expect([...screen.getByText("Failed").classList]).toContain("text-status-error-text");
		});
	});

	it("renders nothing when there are no runs", () => {
		const { container } = render(<RecentRuns runs={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});
