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

import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import ScenarioStepsTab from "./ScenarioStepsTab";
import type { RunScenarioStepElementTally, RunScenarioStepStat } from "@/types";

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

	it("draws each step's method as the coloured, abbreviated MethodBadge", () => {
		// A step's method went through an outline `Badge` with no method colour
		// and no `DEL` abbreviation (#2317).
		render(<ScenarioStepsTab steps={[{ ...STEPS[0], method: "DELETE" }]} virtualUsers={1} />);
		// The badge variant wraps its label; the title and colour sit on the chip.
		const badge = within(rowFor("Log in")).getByText("DEL").parentElement!;
		expect(badge).toHaveAttribute("title", "DELETE");
		expect(badge.style.color).toContain("--method-delete");
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
 * The Tests cell states its scope (#2824): the sampled responses against the
 * responses that carried the step's script, with the assertion split in the
 * title. Mutation-check: render the old passed / failed form unconditionally
 * and the scope cases fail; drop the `population === 0` branch and the
 * pre-`deferred` case fails.
 */
describe("the Tests cell scope", () => {
	const script = (deferred?: number) => [
		{ id: "el_1", kind: "script.post", passed: 0, failed: 0, skipped: 0, deferred },
	];
	const replayed = (over: Partial<RunScenarioStepStat>): RunScenarioStepStat => ({
		...STEPS[1],
		executed: 2_270,
		elements: script(2_270),
		tests: { sampled: 23, passed: 23, failed: 0 },
		...over,
	});

	it("says how many of the step's script-carrying responses were replayed", () => {
		render(<ScenarioStepsTab steps={[replayed({})]} virtualUsers={8} />);

		const cell = within(rowFor("List orders")).getByText("23 of 2,270");
		expect(cell).toHaveAttribute(
			"title",
			"23 passed, 0 failed across 23 sampled responses, of 2,270 that carried a test script"
		);
	});

	it("keeps a failed count in the cell, tinted, rather than only in the title", () => {
		render(
			<ScenarioStepsTab
				steps={[replayed({ tests: { sampled: 20, passed: 17, failed: 3 } })]}
				virtualUsers={8}
			/>
		);

		const row = within(rowFor("List orders"));
		expect(row.getByText(/20 of 2,270/)).toBeTruthy();
		expect(row.getByText(/3 failed/, { selector: "span.text-status-error-text" })).toBeTruthy();
	});

	it("keeps the passed / failed cell for a report stored before `deferred`", () => {
		render(
			<ScenarioStepsTab
				steps={[
					replayed({
						elements: script(undefined),
						tests: { sampled: 8, passed: 5, failed: 3 },
					}),
				]}
				virtualUsers={8}
			/>
		);

		const row = within(rowFor("List orders"));
		expect(row.getByTitle("5 passed, 3 failed across 8 sampled responses")).toBeTruthy();
		expect(row.queryByText(/ of /)).toBeNull();
	});
});

/**
 * The third way an iteration ends (#2824). Mutation-check: drop the
 * subtraction of `abandoned`, or the `Math.max` clamp, and the matching case
 * fails; show the line unconditionally and the "adds up" case fails.
 */
describe("Iterations cut short", () => {
	it("appears for iterations that neither completed nor were abandoned", () => {
		render(
			<ScenarioStepsTab
				steps={STEPS}
				iterations={1_150}
				iterationsCompleted={1_140}
				iterationsAbandoned={0}
			/>
		);

		const label = screen.getByText("Iterations cut short:");
		expect(label.parentElement).toHaveTextContent("Iterations cut short:10");
	});

	it("takes the abandoned iterations out of the count", () => {
		render(
			<ScenarioStepsTab
				steps={STEPS}
				iterations={1_150}
				iterationsCompleted={1_100}
				iterationsAbandoned={40}
			/>
		);

		expect(screen.getByText("Iterations cut short:").parentElement).toHaveTextContent(
			"Iterations cut short:10"
		);
	});

	it("is absent when the three counts add up", () => {
		render(
			<ScenarioStepsTab
				steps={STEPS}
				iterations={480}
				iterationsCompleted={474}
				iterationsAbandoned={6}
			/>
		);

		expect(screen.queryByText(/cut short/)).toBeNull();
	});

	it("reads a disagreeing report as none rather than a negative count", () => {
		render(
			<ScenarioStepsTab
				steps={STEPS}
				iterations={10}
				iterationsCompleted={10}
				iterationsAbandoned={5}
			/>
		);

		expect(screen.queryByText(/cut short/)).toBeNull();
	});

	it("is absent when the report has no started count to derive it from", () => {
		render(<ScenarioStepsTab steps={STEPS} iterationsCompleted={1_140} />);

		expect(screen.queryByText(/cut short/)).toBeNull();
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
				"40 requests deferred to a post-run replay of sampled responses - results in Test validation"
			)
		).toBeTruthy();
		expect(within(rows[1]).queryByText(/passed/)).toBeNull();
		expect(within(rows[1]).queryByText(/skipped/)).toBeNull();
	});

	describe("a missing and an error tally, a name and an origin (issue #3051)", () => {
		const oneRow = (over: Partial<RunScenarioStepElementTally>) => {
			render(
				<ScenarioStepsTab
					steps={[
						{
							...STEPS[0],
							elements: [
								{
									id: "el_9",
									kind: "extract.json",
									passed: 5,
									failed: 0,
									skipped: 0,
									...over,
								},
							],
						},
					]}
					virtualUsers={8}
				/>
			);
			return screen.getAllByRole("row").slice(1)[1];
		};

		it("shows missing and error under their own colours, hidden at zero", () => {
			const row = oneRow({ missing: 3, error: 2 });
			expect(
				within(row).getByText("3 missing", { selector: "span.text-status-warning-text" })
			).toBeTruthy();
			expect(
				within(row).getByText("2 error", { selector: "span.text-status-error-text" })
			).toBeTruthy();
			expect(within(row).queryByText(/skipped/)).toBeNull();
		});

		it("states neither at zero, nor for a row stored before them", () => {
			const row = oneRow({ missing: 0, error: 0 });
			expect(within(row).queryByText(/missing|error/)).toBeNull();
		});

		it("reads a required extractor's miss as a failure", () => {
			const row = oneRow({ required: true, missing: 4 });
			expect(within(row).getByText("4 missing (required)")).toHaveClass(
				"text-status-error-text"
			);
		});

		it("names the element and the collection it came from", () => {
			const row = oneRow({
				name: "Session token",
				origin: { kind: "collection", scope: "collection", name: "Billing" },
			});
			expect(within(row).getByText("Session token")).toBeTruthy();
			expect(within(row).getByText("extract.json")).toBeTruthy();
			expect(within(row).getByText('from "Billing"')).toBeTruthy();
		});

		it("keeps an old-shape row as the bare kind and passed count", () => {
			const row = oneRow({});
			expect(row.textContent).toBe("extract.json5 passed");
		});
	});

	it("renders no element rows for a step with none", () => {
		// Mutation check: reverting to `STEPS` (no `elements` field on either
		// step) must drop back to exactly one row per step.
		render(<ScenarioStepsTab steps={STEPS} virtualUsers={8} />);
		const rows = screen.getAllByRole("row").slice(1);
		expect(rows).toHaveLength(2);
	});
});

/**
 * A step's extractor misses (`scenario.steps[i].extractorMisses`, issue #3053):
 * one row after the step's element rows, only when the engine counted one.
 * Mutation check: drop the misses row from `ScenarioStepsTab.tsx` and the
 * first case fails; render it whatever the count and the second does.
 */
describe("the per-step extractor misses", () => {
	it("counts them in a row of their own under the step that missed", () => {
		render(
			<ScenarioStepsTab
				steps={[
					{
						...STEPS[0],
						extractorMisses: 1234,
						elements: [
							{
								id: "el_1",
								kind: "extract.json",
								passed: 40,
								failed: 0,
								missing: 1234,
								skipped: 0,
							},
						],
					},
					STEPS[1],
				]}
				virtualUsers={8}
			/>
		);

		const rows = screen.getAllByRole("row").slice(1); // drop the header row
		expect(rows).toHaveLength(4);
		expect(within(rows[2]).getByText("1,234 extractor misses")).toBeTruthy();
	});

	it("adds no row for a step without them, or a report from before the count", () => {
		render(
			<ScenarioStepsTab
				steps={[{ ...STEPS[0], extractorMisses: 0 }, STEPS[1]]}
				virtualUsers={8}
			/>
		);

		expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
		expect(screen.queryByText(/extractor miss/)).toBeNull();
	});
});

/**
 * Issue #3127: the step's inline script row lists what the script said, and its
 * deferred row names the step's own sampled-response count. Mutation check:
 * drop `replaySamples` from the `ElementTally` call and the sized cases fail.
 */
describe("what a step's script said and how many responses its replay ran over (issue #3127)", () => {
	const rowOf = (step: Partial<RunScenarioStepStat>) => {
		render(<ScenarioStepsTab steps={[{ ...STEPS[0], ...step }]} virtualUsers={8} />);
		return screen.getAllByRole("row").slice(1)[1];
	};
	const script: RunScenarioStepElementTally = {
		id: "el_4",
		kind: "script.post",
		passed: 0,
		failed: 0,
		error: 480,
		skipped: 0,
	};

	it("lists the thrown error, the failing test and the console under the step", () => {
		const row = rowOf({
			elements: [
				{
					...script,
					messages: [
						{ kind: "error", text: "Error: boom" },
						{ kind: "test", text: "status is 201: expected 200 to equal 201" },
					],
					console: [{ level: "error", text: "saw 500" }],
					consoleDropped: 12,
				},
			],
		});

		expect(within(row).getByText("Error: boom")).toBeTruthy();
		expect(within(row).getByText("status is 201: expected 200 to equal 201")).toBeTruthy();
		expect(within(row).getByText("saw 500")).toHaveClass("text-status-error-text");
		expect(within(row).getByText("12 more console line occurrences not shown")).toBeTruthy();
	});

	it("adds nothing under a row stored before the fields", () => {
		const row = rowOf({ elements: [script] });

		expect(within(row).queryByRole("list")).toBeNull();
		expect(within(row).queryByText(/not shown/)).toBeNull();
	});

	it("sizes a deferred row by this step's sampled responses", () => {
		const row = rowOf({
			tests: { sampled: 500, passed: 480, failed: 20 },
			elements: [{ ...script, error: 0, deferred: 2_270 }],
		});

		expect(
			within(row).getByText(
				"2,270 requests deferred to a post-run replay over 500 sampled responses - results in Test validation"
			)
		).toBeTruthy();
	});

	it("names no size for a step whose replay got no response", () => {
		const row = rowOf({ elements: [{ ...script, error: 0, deferred: 40 }] });

		expect(within(row).getByText(/replay of sampled responses - results in/)).toBeTruthy();
	});
});

describe("the run summary line", () => {
	it("groups thousands in the virtual-user and iteration counts", () => {
		// Mutation check: put a raw `{virtualUsers}` / `{iterationsCompleted}` /
		// `{iterationsAbandoned}` interpolation back and the matching case reddens.
		render(
			<ScenarioStepsTab
				steps={STEPS}
				virtualUsers={12345}
				iterationsCompleted={23456}
				iterationsAbandoned={34567}
			/>
		);
		expect(screen.getByText("12,345")).toBeTruthy();
		expect(screen.getByText("23,456")).toBeTruthy();
		expect(screen.getByText("34,567")).toBeTruthy();
	});
});

/**
 * Issue #3101: a step's collection element and its request's own can share an
 * id, and the breakdown keeps a row for each (#3100). Mutation check: key the
 * element row by `element.id` alone and React warns about a duplicate key.
 */
describe("two levels of a step sharing an element id (issue #3101)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders both rows without a duplicate-key warning", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const shared = (name: string, origin: RunScenarioStepElementTally["origin"]) => ({
			id: "el_1",
			kind: "assert.status",
			name,
			origin,
			passed: 1,
			failed: 0,
			skipped: 0,
		});
		render(
			<ScenarioStepsTab
				steps={[
					{
						...STEPS[0],
						elements: [
							shared("Collection check", {
								kind: "collection",
								scope: "collection",
								id: "col_1",
							}),
							shared("Request check", {
								kind: "request",
								scope: "request",
								id: "req_a",
							}),
						],
					},
				]}
				virtualUsers={8}
			/>
		);
		expect(screen.getByText("Collection check")).toBeTruthy();
		expect(screen.getByText("Request check")).toBeTruthy();
		const keyWarnings = consoleError.mock.calls.filter((call) =>
			call.some((arg) => typeof arg === "string" && arg.includes("same key"))
		);
		expect(keyWarnings).toEqual([]);
	});
});
