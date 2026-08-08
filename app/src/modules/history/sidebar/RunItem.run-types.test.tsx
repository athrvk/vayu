/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * How each run type reads in the history sidebar.
 *
 * A collection run has no url and no method - its work is a sequence - so every
 * `summary` branch written for a load or design run leaves its row as a status
 * and a timestamp and nothing else. `summary.scenario` is what it has instead,
 * and the cases below are about the row using it: which collection ran, how big
 * the run was, and an accessible name that says which of the three kinds of run
 * this is.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function run(type: Run["type"]): Run {
	return {
		id: "run_1",
		type,
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/checkout",
			method: "POST",
		},
	} as Run;
}

/** A collection run's row, as the paginated `GET /runs` sends one. */
function scenarioRun(scenario: Record<string, unknown>): Run {
	return {
		id: "run_2",
		type: "scenario",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: null,
		environmentId: null,
		summary: { scenario },
	} as Run;
}

const noop = () => {};

describe("RunItem run types", () => {
	it("renders a scenario run row", () => {
		render(
			<RunItem run={run("scenario")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);

		expect(screen.getByText("https://api.example.test/checkout")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Open .* run, completed/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete run" })).toBeInTheDocument();
	});

	it("names the collection that ran, where another row would show a url", () => {
		render(
			<RunItem
				run={scenarioRun({ collectionId: "col_1", stepCount: 4, iterations: 2 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
				collectionName="Checkout flow"
			/>
		);

		expect(screen.getByText("Checkout flow")).toBeInTheDocument();
		expect(screen.getByText("4 steps")).toBeInTheDocument();
		expect(screen.getByText("2 iterations")).toBeInTheDocument();
	});

	it("falls back to the id when the collection has been deleted since", () => {
		// The row has the id and nothing else; showing it beats a blank line,
		// and inventing a name for a folder that is gone would be worse than
		// either.
		render(
			<RunItem
				run={scenarioRun({ collectionId: "col_gone", stepCount: 1 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(screen.getByText("col_gone")).toBeInTheDocument();
		// One step, not "1 steps".
		expect(screen.getByText("1 step")).toBeInTheDocument();
	});

	it("leaves out a single iteration, which is the default and says nothing", () => {
		render(
			<RunItem
				run={scenarioRun({ collectionId: "col_1", stepCount: 3, iterations: 1 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
				collectionName="Checkout flow"
			/>
		);

		expect(screen.queryByText("1 iterations")).not.toBeInTheDocument();
		expect(screen.getByText("3 steps")).toBeInTheDocument();
	});

	it("renders a scenario row stored before the engine sent the descriptor", () => {
		// `type` says scenario, the payload says nothing. The row must still
		// render rather than reaching into an absent object.
		render(
			<RunItem
				run={{ ...scenarioRun({}), summary: {} } as Run}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(
			screen.getByRole("button", { name: /Open collection run, completed/ })
		).toBeInTheDocument();
	});

	it("announces each run type as what it is", () => {
		// A collection run announced as a "request run", with no url after it,
		// was a row a screen-reader user could not tell apart from any other.
		const labels: Record<string, RegExp> = {
			load: /Open load test run/,
			design: /Open request run/,
		};
		for (const [type, pattern] of Object.entries(labels)) {
			const { unmount } = render(
				<RunItem
					run={run(type as Run["type"])}
					onSelect={noop}
					onDelete={vi.fn()}
					isDeleting={false}
				/>
			);
			expect(screen.getByRole("button", { name: pattern })).toBeInTheDocument();
			unmount();
		}

		render(
			<RunItem
				run={scenarioRun({ collectionId: "col_1", stepCount: 2 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
				collectionName="Checkout flow"
			/>
		);
		expect(
			screen.getByRole("button", { name: /Open collection run, completed, Checkout flow/ })
		).toBeInTheDocument();
	});

	it("keeps the load badge to load runs", () => {
		// Counting icons was the old shape of this test and it never meant much;
		// the rule is *which* badge, so that is what is read.
		const scenario = render(
			<RunItem
				run={scenarioRun({ collectionId: "col_1", stepCount: 2 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		).container;
		expect(scenario.querySelector(".text-purple-500")).toBeNull();

		const load = render(
			<RunItem run={run("load")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		).container;
		expect(load.querySelector(".text-purple-500")).not.toBeNull();
	});

	/**
	 * The badge slot beside Delete marks the run types whose identity line would
	 * otherwise look the same - load and design, which both print a bare URL. A
	 * collection run's identity is a folder name over a steps/iterations line, so
	 * a badge there is a third glyph saying what the folder icon and the step
	 * count already say, and it was drawn with the *same* glyph as the step count.
	 *
	 * Read by glyph count rather than by class: this is about one card not
	 * repeating a picture, which a class assertion cannot see.
	 */
	it("does not repeat the step-count glyph as a type badge", () => {
		const { container } = render(
			<RunItem
				run={scenarioRun({ collectionId: "col_1", stepCount: 4, iterations: 2 })}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
				collectionName="Checkout flow"
			/>
		);

		// lucide stamps its name onto the node (`lucide-list-ordered`), so
		// identical glyphs are countable. Every icon in the card must differ.
		const glyphs = Array.from(container.querySelectorAll("svg")).map(
			(n) => n.getAttribute("class")?.match(/lucide-[a-z0-9-]+/)?.[0] ?? "unknown"
		);

		// Prove the scan read something before trusting what it did not find - a
		// guard that matched nothing would "pass" on an empty list forever.
		expect(glyphs.length).toBeGreaterThan(3);
		expect(glyphs).not.toContain("unknown");
		expect(glyphs).toContain("lucide-list-ordered");

		expect(new Set(glyphs).size).toBe(glyphs.length);
	});
});
