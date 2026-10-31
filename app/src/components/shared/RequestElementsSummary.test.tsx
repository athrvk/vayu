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
 * Issue #1641: the engine wrote a single-request load run's per-element
 * tally into its report; nothing rendered it. Mutation check: drop the
 * emptiness guard and the "says nothing" cases fail; drop the component from
 * OverviewTab and its own rendering test still passes but the report
 * silently loses the row.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestElementsSummary } from "./RequestElementsSummary";
import type { RunScenarioStepElementTally } from "@/types/domain";

function tally(overrides: Partial<RunScenarioStepElementTally> = {}): RunScenarioStepElementTally {
	return { id: "el_1", kind: "assert.status", passed: 1, failed: 0, skipped: 0, ...overrides };
}

describe("RequestElementsSummary", () => {
	it.each([{ elements: undefined }, { elements: [] }])(
		"says nothing when the elements section is $elements",
		({ elements }) => {
			const { container } = render(<RequestElementsSummary elements={elements} />);
			expect(container.firstChild).toBeNull();
		}
	);

	it("shows a passing element's kind and count", () => {
		render(<RequestElementsSummary elements={[tally({ passed: 42 })]} />);
		expect(screen.getByText("assert.status")).toBeTruthy();
		expect(screen.getByText("42 passed")).toBeTruthy();
	});

	it("shows failed and skipped only when non-zero", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "extract.json", passed: 3, failed: 1, skipped: 2 })]}
			/>
		);
		expect(screen.getByText("3 passed")).toBeTruthy();
		expect(screen.getByText("1 failed")).toBeTruthy();
		expect(screen.getByText("2 skipped")).toBeTruthy();
	});

	it("omits failed and skipped rows at zero", () => {
		render(<RequestElementsSummary elements={[tally({ passed: 5 })]} />);
		expect(screen.queryByText(/failed/)).toBeNull();
		expect(screen.queryByText(/skipped/)).toBeNull();
	});

	describe("a deferred post-request script (issue #2144)", () => {
		const deferredScript = (overrides: Partial<RunScenarioStepElementTally> = {}) =>
			tally({ kind: "script.post", passed: 0, skipped: 0, deferred: 235_690, ...overrides });

		it("says it was replayed and where the results are, not '0 passed'", () => {
			render(<RequestElementsSummary elements={[deferredScript()]} />);

			expect(
				screen.getByText(
					"235,690 requests deferred to a post-run replay of sampled responses - results in Test validation"
				)
			).toBeTruthy();
			expect(screen.queryByText(/passed/)).toBeNull();
			expect(screen.queryByText(/skipped/)).toBeNull();
		});

		it("uses the singular for one response", () => {
			render(<RequestElementsSummary elements={[deferredScript({ deferred: 1 })]} />);
			expect(
				screen.getByText(
					"1 request deferred to a post-run replay of sampled responses - results in Test validation"
				)
			).toBeTruthy();
		});

		it("still states the other tallies when the row is mixed", () => {
			render(
				<RequestElementsSummary
					elements={[deferredScript({ deferred: 5, passed: 3, failed: 1, skipped: 2 })]}
				/>
			);
			expect(screen.getByText(/5 requests deferred to a post-run replay/)).toBeTruthy();
			expect(screen.getByText("3 passed")).toBeTruthy();
			expect(screen.getByText("1 failed")).toBeTruthy();
			expect(screen.getByText("2 skipped")).toBeTruthy();
		});

		it("keeps a skipped-only row, such as an un-inlined script.pre, as skipped", () => {
			render(
				<RequestElementsSummary
					elements={[tally({ kind: "script.pre", passed: 0, skipped: 9, deferred: 0 })]}
				/>
			);
			expect(screen.getByText("9 skipped")).toBeTruthy();
			expect(screen.getByText("0 passed")).toBeTruthy();
			expect(screen.queryByText(/replayed/)).toBeNull();
		});

		it("renders a report stored before the field as it always did", () => {
			render(<RequestElementsSummary elements={[tally({ passed: 0, skipped: 7 })]} />);
			expect(screen.getByText("0 passed")).toBeTruthy();
			expect(screen.getByText("7 skipped")).toBeTruthy();
			expect(screen.queryByText(/replayed/)).toBeNull();
		});
	});

	it("renders one row per element", () => {
		render(
			<RequestElementsSummary
				elements={[
					tally({ id: "el_1", kind: "assert.status" }),
					tally({ id: "el_2", kind: "timer.think" }),
				]}
			/>
		);
		expect(screen.getByText("assert.status")).toBeTruthy();
		expect(screen.getByText("timer.think")).toBeTruthy();
	});
});

/**
 * Issue #3051: `missing` and `error` are counts of their own, and a row names
 * its element. `ScenarioStepsTab.test.tsx` drives the same cases through the
 * other parent of the shared `ElementTally`.
 */
describe("a missing and an error tally, a name and an origin (issue #3051)", () => {
	it("shows missing as a warning and error as an error, apart from skipped and failed", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "extract.json", passed: 5, missing: 3, error: 2 })]}
			/>
		);
		expect(
			screen.getByText("3 missing", { selector: "span.text-status-warning-text" })
		).toBeTruthy();
		expect(
			screen.getByText("2 error", { selector: "span.text-status-error-text" })
		).toBeTruthy();
		expect(screen.queryByText(/failed/)).toBeNull();
		expect(screen.queryByText(/skipped/)).toBeNull();
	});

	it("hides both at zero, and when the report predates them", () => {
		render(
			<RequestElementsSummary
				elements={[
					tally({ id: "el_zero", kind: "extract.json", missing: 0, error: 0 }),
					tally({ id: "el_old", kind: "assert.status" }),
				]}
			/>
		);
		expect(screen.queryByText(/missing/)).toBeNull();
		expect(screen.queryByText(/error/)).toBeNull();
	});

	it("reads a required extractor's miss as a failure", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "extract.json", required: true, missing: 4 })]}
			/>
		);
		const miss = screen.getByText("4 missing (required)");
		expect(miss).toHaveClass("text-status-error-text");
		expect(miss).not.toHaveClass("text-status-warning-text");
		expect(miss).toHaveAttribute("title", expect.stringMatching(/fails the step/));
	});

	it("names the element, with its kind beside it, and the collection it came from", () => {
		render(
			<RequestElementsSummary
				elements={[
					tally({
						kind: "extract.json",
						name: "Session token",
						origin: { kind: "collection", scope: "collection", name: "Billing" },
					}),
				]}
			/>
		);
		expect(screen.getByText("Session token")).toBeTruthy();
		expect(screen.getByText("extract.json")).toBeTruthy();
		expect(screen.getByText('from "Billing"')).toBeTruthy();
	});

	it("says nothing about the origin of a request's own element", () => {
		const { container } = render(
			<RequestElementsSummary
				elements={[
					tally({
						name: "Is 200",
						origin: { kind: "request", scope: "request", name: "Log in" },
					}),
				]}
			/>
		);
		expect(screen.getByText("Is 200")).toBeTruthy();
		expect(container.textContent).not.toMatch(/from|Log in/);
	});

	it("keeps an unnamed, old-shape row as the bare kind", () => {
		const { container } = render(
			<RequestElementsSummary elements={[tally({ kind: "assert.status", passed: 7 })]} />
		);
		expect(container.querySelector("li")?.textContent).toBe("assert.status7 passed");
	});
});

/**
 * Issue #3101: an id is unique only within its level, so a collection's element
 * and the request's own can share one, and the report keeps a row for each.
 * Mutation check: key the row by `element.id` alone and React warns about a
 * duplicate key.
 */
describe("two levels sharing an element id (issue #3101)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders both rows without a duplicate-key warning", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			<RequestElementsSummary
				elements={[
					tally({
						name: "Collection check",
						passed: 3,
						origin: { kind: "collection", scope: "collection", id: "col_1" },
					}),
					tally({
						name: "Request check",
						passed: 0,
						failed: 2,
						origin: { kind: "request", scope: "request", id: "req_1" },
					}),
				]}
			/>
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(screen.getByText("Collection check")).toBeTruthy();
		expect(screen.getByText("Request check")).toBeTruthy();
		expect(screen.getByText("2 failed")).toBeTruthy();
		const keyWarnings = consoleError.mock.calls.filter((call) =>
			call.some((arg) => typeof arg === "string" && arg.includes("same key"))
		);
		expect(keyWarnings).toEqual([]);
	});
});

/**
 * Issue #3127: an inline script row says what the script threw, failed and
 * logged, and a deferred row names the size of the replay that judged it.
 * `ScenarioStepsTab.test.tsx` drives the same cases through the other parent.
 */
describe("what a script said and how many responses its replay ran over (issue #3127)", () => {
	const script = (overrides: Partial<RunScenarioStepElementTally> = {}) =>
		tally({ kind: "script.post", passed: 0, error: 480, ...overrides });

	it("lists the thrown error, the failing test and the console beside the tally", () => {
		render(
			<RequestElementsSummary
				elements={[
					script({
						messages: [
							{ kind: "error", text: "Error: boom" },
							{ kind: "test", text: "status is 201: expected 200 to equal 201" },
						],
						console: [{ level: "warn", text: "saw 200" }],
					}),
				]}
			/>
		);

		expect(screen.getByText("480 error")).toBeTruthy();
		expect(screen.getByText("Error: boom")).toBeTruthy();
		expect(screen.getByText("status is 201: expected 200 to equal 201")).toBeTruthy();
		expect(screen.getByText("saw 200")).toHaveClass("text-status-warning-text");
	});

	it("cues what a full list turned away", () => {
		render(
			<RequestElementsSummary
				elements={[
					script({
						messages: [{ kind: "error", text: "Error: boom" }],
						messagesDropped: 4,
						console: [{ level: "log", text: "hello" }],
						consoleDropped: 37,
					}),
				]}
			/>
		);

		expect(screen.getByText("4 more messages not shown")).toBeTruthy();
		expect(screen.getByText("37 more console lines not shown")).toBeTruthy();
	});

	it("renders a row stored before the fields with no message block", () => {
		render(<RequestElementsSummary elements={[script()]} />);

		expect(screen.getByText("480 error")).toBeTruthy();
		expect(screen.queryByText(/not shown/)).toBeNull();
		expect(screen.getAllByRole("list")).toHaveLength(1);
	});

	it("names the replay's sample size on a deferred row", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "script.post", passed: 0, deferred: 235_690 })]}
				replaySamples={1_000}
			/>
		);

		expect(
			screen.getByText(
				"235,690 requests deferred to a post-run replay over 1,000 sampled responses - results in Test validation"
			)
		).toBeTruthy();
	});

	it("uses the singular for a replay over one response", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "script.post", passed: 0, deferred: 9 })]}
				replaySamples={1}
			/>
		);

		expect(screen.getByText(/replay over 1 sampled response - results in/)).toBeTruthy();
	});

	it("names no size when the report does not carry one", () => {
		render(
			<RequestElementsSummary
				elements={[tally({ kind: "script.post", passed: 0, deferred: 9 })]}
			/>
		);

		expect(screen.getByText(/replay of sampled responses - results in/)).toBeTruthy();
		expect(screen.queryByText(/replay over/)).toBeNull();
	});
});
