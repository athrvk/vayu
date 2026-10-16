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
 * The per-step breakdown of a scenario load run (issue #357).
 *
 * A scenario load run stores no per-step `results` rows, so this table is the
 * only place it says what each step did - which is why the numbers, and not
 * just the layout, are asserted here.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import ScenarioStepsTab from "./ScenarioStepsTab";
import type { RunScenarioStepStat } from "@/types";

const STEPS: RunScenarioStepStat[] = [
	{
		index: 0,
		name: "Log in",
		requestId: "req_a",
		method: "POST",
		executed: 40,
		errors: 0,
		latency: { min: 0.4, p50: 4, p95: 9, p99: 12, max: 30 },
	},
	{
		index: 1,
		name: "List orders",
		requestId: "req_b",
		method: "GET",
		executed: 34,
		errors: 6,
		latency: { min: 2, p50: 15, p95: 40, p99: 90, max: 120 },
	},
];

const rowFor = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

describe("the step table", () => {
	it("lists every plan step in order with its counts and latency", () => {
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);

		const rows = screen.getAllByRole("row").slice(1); // drop the header row
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByText("Log in")).toBeTruthy();
		expect(within(rows[0]).getByText("POST")).toBeTruthy();
		expect(within(rows[1]).getByText("List orders")).toBeTruthy();
		// p99 and max of the second step.
		expect(within(rows[1]).getByText("90ms")).toBeTruthy();
		expect(within(rows[1]).getByText("120ms")).toBeTruthy();
	});

	it("shows a sub-millisecond latency rather than rounding it to 0ms", () => {
		// A loopback step's p50 is routinely a fraction of a millisecond, and a
		// whole-number format would render every one of them "0ms" - a table of
		// zeroes that looks like a broken measurement.
		const loopback = { ...STEPS[0], latency: { ...STEPS[0].latency, p50: 0.4 } };
		render(<ScenarioStepsTab steps={[loopback]} virtualUsers={1} />);
		expect(within(rowFor("Log in")).getByText("0.4ms")).toBeTruthy();
		expect(within(rowFor("Log in")).getByText("9ms")).toBeTruthy();
	});

	it("says how far short of the first step a later one ran", () => {
		// A step that got no response ends its iteration, so the steps after it
		// run fewer times. Saying so is what stops the reader concluding the run
		// simply lost requests.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);
		expect(within(rowFor("List orders")).getByText(/\(6 short\)/)).toBeTruthy();
		expect(within(rowFor("Log in")).queryByText(/short/)).toBeNull();
	});

	it("reports the run's virtual users and abandoned iterations", () => {
		render(
			<ScenarioStepsTab
				steps={STEPS}
				virtualUsers={8}
				iterationsCompleted={34}
				iterationsAbandoned={6}
			/>
		);

		expect(screen.getByText(/virtual users/i)).toBeTruthy();
		expect(screen.getByText("8")).toBeTruthy();
		expect(screen.getByText(/iterations abandoned/i)).toBeTruthy();
	});

	it("stays silent about abandoned iterations when none were", () => {
		// Zero next to the word "abandoned" reads as a warning that is not there.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} iterationsAbandoned={0} />);
		expect(screen.queryByText(/iterations abandoned/i)).toBeNull();
	});

	it("renders nothing at all for a run with no breakdown", () => {
		const { container } = render(<ScenarioStepsTab steps={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("keeps a wide table inside its own scroll box", () => {
		// The page body must never scroll horizontally; an eight-column table on a
		// narrow window is exactly what would make it.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);
		const table = screen.getByRole("table");
		expect(table.parentElement?.className).toContain("overflow-x-auto");
	});
});

/**
 * The Errors column counts HTTP error responses as well as requests that got no
 * response (issue #2134); only the second ends an iteration, so the tooltip
 * keeps the two apart.
 */
describe("the Errors column", () => {
	const errorsCell = (name: string) => within(rowFor(name)).getByText("6").closest("td")!;

	it("shows the red count and splits it into HTTP errors and no response on hover", async () => {
		const split: RunScenarioStepStat[] = [
			STEPS[0],
			{ ...STEPS[1], errors: 6, httpErrors: 4, noResponse: 2 },
		];
		render(<ScenarioStepsTab steps={split} virtualUsers={8} />);

		const cell = errorsCell("List orders");
		expect(cell.className).toContain("text-status-error-text");
		fireEvent.pointerMove(within(cell).getByText("6"), { pointerType: "mouse" });

		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"4 HTTP errors, 2 no response"
		);
	});

	it("uses the singular for a lone HTTP error", async () => {
		const one: RunScenarioStepStat[] = [
			{ ...STEPS[1], errors: 6, httpErrors: 1, noResponse: 5 },
		];
		render(<ScenarioStepsTab steps={one} virtualUsers={8} />);

		fireEvent.pointerMove(within(errorsCell("List orders")).getByText("6"), {
			pointerType: "mouse",
		});

		expect(await screen.findByRole("tooltip")).toHaveTextContent("1 HTTP error, 5 no response");
	});

	it("shows the bare count, with no split, for a report stored before the split", () => {
		// `STEPS[1]` carries `errors: 6` and neither `httpErrors` nor `noResponse`,
		// the shape an older stored report has.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);

		const cell = errorsCell("List orders");
		expect(cell.className).toContain("text-status-error-text");
		fireEvent.pointerMove(within(cell).getByText("6"), { pointerType: "mouse" });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("leaves a step with no errors muted and without a tooltip", () => {
		const clean: RunScenarioStepStat[] = [{ ...STEPS[0], httpErrors: 0, noResponse: 0 }];
		render(<ScenarioStepsTab steps={clean} virtualUsers={8} />);

		const cell = within(rowFor("Log in")).getByText("0").closest("td")!;
		expect(cell.className).toContain("text-muted-foreground");
		fireEvent.pointerMove(within(cell).getByText("0"), { pointerType: "mouse" });
		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});

/**
 * The deferred per-step validation (issue #450): each step's own post-request
 * script, replayed after the run against that step's sampled responses. Before
 * it, a collection's assertions passed in design mode and were silently never
 * checked by a load run of the same collection.
 */
describe("the per-step test tallies", () => {
	const WITH_TESTS: RunScenarioStepStat[] = [
		{ ...STEPS[0], tests: { sampled: 10, passed: 10, failed: 0 } },
		{ ...STEPS[1], tests: { sampled: 8, passed: 5, failed: 3 } },
	];

	it("reports each step's own passes and failures", () => {
		render(<ScenarioStepsTab steps={WITH_TESTS} virtualUsers={8} />);

		// The failing step names its own count, which is the whole point of the
		// breakdown: a whole-run total says something failed, not which step.
		const failing = within(rowFor("List orders"));
		expect(failing.getByText("5")).toBeTruthy();
		expect(failing.getByText(/3/, { selector: "span.text-status-error-text" })).toBeTruthy();
		expect(failing.getByTitle("5 passed, 3 failed across 8 sampled responses")).toBeTruthy();
		expect(
			within(rowFor("Log in")).getByTitle("10 passed, 0 failed across 10 sampled responses")
		).toBeTruthy();
	});

	it("shows a dash, never a zero, for a step that asserted nothing", () => {
		// "No assertions" and "no failures" are different answers - the engine
		// omits the object rather than writing zeros, and so must the table.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);
		expect(within(rowFor("Log in")).getByTitle("No assertions")).toBeTruthy();
		expect(within(rowFor("List orders")).getByTitle("No assertions")).toBeTruthy();
	});

	it("tints only the failed count", () => {
		// The passed count is not an error, and a whole cell in the error colour
		// would say the step's assertions all failed.
		render(<ScenarioStepsTab steps={WITH_TESTS} virtualUsers={8} />);
		const failed = within(rowFor("List orders")).getByText(/3/, {
			selector: "span.text-status-error-text",
		});
		expect(failed).toBeTruthy();
		expect(
			within(rowFor("Log in")).queryByText(/10/, {
				selector: "span.text-status-error-text",
			})
		).toBeNull();
	});
});

/**
 * Non-script elements - extractors, assertions, timers - tallied per step
 * across every virtual user and iteration (`scenario.steps[i].elements`,
 * issue #1495). Written by the engine since #1495 but never rendered until
 * this reopen of #1516: the sequential run's per-step outcomes show up in
 * `ScenarioStepCard`, and a load run's counterpart had no reader at all.
 */
describe("the per-step element tallies", () => {
	const WITH_ELEMENTS: RunScenarioStepStat[] = [
		{
			...STEPS[0],
			elements: [{ id: "el_1", kind: "extract.json", passed: 40, failed: 0, skipped: 0 }],
		},
		{
			...STEPS[1],
			elements: [{ id: "el_2", kind: "assert.status", passed: 30, failed: 4, skipped: 2 }],
		},
	];

	it("shows a row per element under its step, with kind and every non-zero count", () => {
		render(<ScenarioStepsTab steps={WITH_ELEMENTS} virtualUsers={8} />);

		const rows = screen.getAllByRole("row").slice(1); // drop the header row
		// Each step row is followed by one row per element it compiled.
		expect(rows).toHaveLength(4);

		expect(within(rows[1]).getByText("extract.json")).toBeTruthy();
		expect(within(rows[1]).getByText("40 passed")).toBeTruthy();

		expect(within(rows[3]).getByText("assert.status")).toBeTruthy();
		expect(within(rows[3]).getByText("30 passed")).toBeTruthy();
		expect(
			within(rows[3]).getByText("4 failed", { selector: "span.text-status-error-text" })
		).toBeTruthy();
		expect(within(rows[3]).getByText("2 skipped")).toBeTruthy();
	});

	it("omits the failed and skipped counts when they are zero", () => {
		// An element that never failed or was never skipped states neither -
		// the same "absent when nothing happened" reading the Tests column
		// already gives a step that asserted nothing.
		render(<ScenarioStepsTab steps={WITH_ELEMENTS} virtualUsers={8} />);
		const rows = screen.getAllByRole("row").slice(1);
		expect(within(rows[1]).queryByText(/failed/)).toBeNull();
		expect(within(rows[1]).queryByText(/skipped/)).toBeNull();
	});

	it("says a deferred post-request script was replayed, not that it passed nothing", () => {
		// The same row the single-request Elements card draws: both read the
		// shared `ElementTally`, so the field cannot be wired into one only.
		render(
			<ScenarioStepsTab
				steps={[
					{
						...STEPS[0],
						elements: [
							{
								id: "el_3",
								kind: "script.post",
								passed: 0,
								failed: 0,
								skipped: 0,
								deferred: 40,
							},
						],
					},
				]}
				virtualUsers={8}
			/>
		);
		const rows = screen.getAllByRole("row").slice(1);
		expect(
			within(rows[1]).getByText(
				"40 requests deferred to a post-run replay of sampled responses - results in Test Validation"
			)
		).toBeTruthy();
		expect(within(rows[1]).queryByText(/passed/)).toBeNull();
		expect(within(rows[1]).queryByText(/skipped/)).toBeNull();
	});

	it("renders no element rows for a step with none", () => {
		// Mutation check: reverting to `STEPS` (no `elements` field on either
		// step) must drop back to exactly one row per step.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);
		const rows = screen.getAllByRole("row").slice(1);
		expect(rows).toHaveLength(2);
	});
});
