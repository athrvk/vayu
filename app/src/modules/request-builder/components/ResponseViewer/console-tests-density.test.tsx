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
 * The Console and Tests panels, after the same two treatments the rest of this
 * pane got.
 *
 * **Density.** Both ran at `text-sm` with 20px icons while the tab strip, the
 * toolbar, the tables and the timing legend around them are 12px and 11px with
 * 14px icons. The Tests panel is the one tab whose job is listing every
 * assertion a script made, and it was giving each one a ~52px row.
 *
 * **Duplication.** `ConsoleOutput` was 212 lines, roughly 120 of them two pairs
 * of near-identical blocks - the pre/post error cards and the pre/test log
 * sections - each pair differing in a status token and a heading. They are one
 * `ScriptError` and one `ScriptLogs` now. What that risks is the same thing the
 * script-panel extraction risked: a section rendering the *other* one's content,
 * which looks entirely correct. So both sections are asserted to carry their own
 * label and their own logs.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";

/*
 * jsdom ships no `IntersectionObserver`, and the hook falls back to rendering
 * everything without one. That fallback is correct for the app - it can only
 * happen where windowing is impossible, and showing all rows beats hiding rows
 * you cannot reach - but it is not what these assert. A stub that never fires
 * puts the real windowing path under test: the first slice renders, and nothing
 * grows it.
 */
beforeAll(() => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
			root = null;
			rootMargin = "";
			thresholds = [];
		}
	);
});

afterAll(() => vi.unstubAllGlobals());

const RESULTS = [
	{ name: "status is 200", passed: true },
	{ name: "body has id", passed: false, error: "expected undefined to exist" },
];

/**
 * A size a step above the pane's, written *unprefixed*.
 *
 * The leading `(^|\s)` matters. A bare `\btext-sm\b` also matches
 * `file:text-sm`, which the shared `Input` primitive carries for
 * `::file-selector-button` - a pseudo-element a text input does not have, so it
 * styles nothing and says nothing about this panel's density. It flagged the
 * filter field and would have kept flagging every primitive that ships a
 * variant, until someone made the guard lie instead.
 *
 * A variant-prefixed class is also not this panel choosing a size: it is a
 * shared component's own responsive or state rule. What is being guarded is the
 * unqualified choice.
 */
const OVERSIZED = /(^|\s)(text-sm|w-5|h-5)(\s|$)/;

function consoleOutput() {
	return render(
		<ConsoleOutput
			logs={["[pre] token minted", "assertion ran", "[pre] header set"]}
			errors={{}}
		/>
	);
}

describe("the two console sections", () => {
	it("keeps each script's logs under its own heading", () => {
		/*
		 * The crossing an extraction can introduce. Both sections render the same
		 * component, so a swapped key puts the pre-request logs under "Test
		 * Script" and nothing about the result looks wrong.
		 */
		const { container } = consoleOutput();
		const sections = Array.from(container.querySelectorAll<HTMLElement>("[data-state]"));
		expect(sections.length).toBeGreaterThanOrEqual(2);

		const pre = sections.find((s) => s.textContent?.includes("Pre-request Script"));
		const test = sections.find((s) => s.textContent?.includes("Test Script"));
		expect(pre).toBeTruthy();
		expect(test).toBeTruthy();

		expect(pre!.textContent).toContain("token minted");
		expect(pre!.textContent).toContain("header set");
		expect(pre!.textContent).not.toContain("assertion ran");

		expect(test!.textContent).toContain("assertion ran");
		expect(test!.textContent).not.toContain("token minted");
	});

	it("carries no count badge, on either section", () => {
		/*
		 * They restated what the slab below each heading already shows, and on a
		 * short console - two lines, one per script - the row was mostly numbers
		 * about very little.
		 */
		/*
		 * Asserted per element, not against `container.textContent`.
		 *
		 * The first attempt matched `/\d+\s*logs?\b/` on the whole text and could
		 * never fire: `textContent` concatenates without separators, so a badge
		 * renders as `...2 logstoken minted...` and the trailing `\b` demands a
		 * boundary between `s` and `t` that is not there. It passed against its
		 * own mutation, which is the only reason it was caught.
		 */
		const { container } = consoleOutput();
		const counts = Array.from(container.querySelectorAll("*")).filter((el) =>
			/^\d+\s*logs?$/.test(el.textContent?.trim() ?? "")
		);
		expect(counts.map((el) => el.textContent)).toEqual([]);
	});

	it("labels an error by the script that raised it", () => {
		render(<ConsoleOutput logs={[]} errors={{ pre: "boom", post: "bang" }} />);
		expect(screen.getByText(/pre-request script error/i)).toBeInTheDocument();
		expect(screen.getByText(/test script error/i)).toBeInTheDocument();
	});

	it("draws an error in destructive tokens, not the section's own tone", () => {
		// An error is state, not identity - it has to read as a failure whichever
		// script raised it, so it does not take that section's running/success hue.
		const { container } = render(<ConsoleOutput logs={[]} errors={{ pre: "boom" }} />);
		const card = container.querySelector<HTMLElement>(".bg-destructive\\/10");
		expect(card, "the error card").not.toBeNull();
		expect(card!.className).not.toMatch(/status-(running|success)/);
	});
});

describe("console density", () => {
	it("sizes its text and icons to the pane, not one step up", () => {
		const { container } = consoleOutput();
		const oversized = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			OVERSIZED.test(el.className)
		);
		expect(oversized.map((el) => el.className)).toEqual([]);
	});
});

describe("tests density", () => {
	it("sizes its rows to the pane", () => {
		const { container } = render(<TestResults results={RESULTS} />);
		const oversized = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			OVERSIZED.test(el.className)
		);
		expect(oversized.map((el) => el.className)).toEqual([]);
	});

	it("summarises as text, not as a second chip", () => {
		/*
		 * The tab trigger directly above already carries a pass/fail chip. A
		 * Badge here restated it, more loudly than the results it summarised.
		 */
		const { container } = render(<TestResults results={RESULTS} />);
		expect(container.querySelector('[data-slot="badge"]')).toBeNull();
		expect(container.textContent).toMatch(/1\s*passed/);
		expect(container.textContent).toMatch(/1\s*failed/);
	});

	it("says nothing about failures when there are none", () => {
		// "0 failed" is noise on a passing run; the absence is the message.
		const { container } = render(<TestResults results={[{ name: "ok", passed: true }]} />);
		expect(container.textContent).toMatch(/1\s*passed/);
		expect(container.textContent).not.toMatch(/failed/);
	});

	it("shows a failure's message, which is the reason you opened the tab", () => {
		render(<TestResults results={RESULTS} />);
		expect(screen.getByText(/expected undefined to exist/i)).toBeInTheDocument();
	});

	it("keeps each row's own result colour", () => {
		const { container } = render(<TestResults results={RESULTS} />);
		expect(container.querySelector(".bg-status-success\\/10")).not.toBeNull();
		expect(container.querySelector(".bg-status-error\\/10")).not.toBeNull();
	});
});

describe("both panels' boxes", () => {
	it("carry a radius, so they are not pinned square for a Rounded user", () => {
		const boxes = (c: HTMLElement) =>
			Array.from(c.querySelectorAll<HTMLElement>("*")).filter((el) =>
				/\bbg-(status|destructive)/.test(el.className)
			);

		for (const { container } of [
			render(<TestResults results={RESULTS} />),
			render(<ConsoleOutput logs={[]} errors={{ pre: "boom" }} />),
		]) {
			const found = boxes(container);
			expect(found.length).toBeGreaterThan(0);
			for (const box of found) {
				expect(box.className).toMatch(/\brounded-(sm|md|lg|full)\b/);
			}
		}
	});
});

/**
 * Console output is unbounded and stays that way.
 *
 * `script_engine.cpp` pushes every `console.log` line into a vector with no cap,
 * so a script with a loop can produce a hundred thousand of them - and the user
 * asked for every one. Capping was considered and rejected: the engine holds
 * them comfortably, and what falls over is the DOM, so the fix belongs there.
 *
 * Nothing is withheld. Rows arrive as you reach them, `content-visibility` keeps
 * off-screen ones from costing layout, and the filter searches *all* of them
 * rather than the rendered slice.
 */
describe("a very long console", () => {
	const MANY = Array.from({ length: 5000 }, (_, i) => `line ${i}`);

	it("renders a bounded slice rather than every line", () => {
		const { container } = render(<ConsoleOutput logs={MANY} errors={{}} />);
		const rows = container.querySelectorAll("pre");
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(MANY.length);
	});

	it("says how much of it is showing, rather than leaving it to a scrollbar", () => {
		const { container } = render(<ConsoleOutput logs={MANY} errors={{}} />);
		expect(container.textContent).toMatch(/showing[\s\S]*5,000/i);
	});

	it("marks its rows skippable so the ones off screen cost no layout", () => {
		const { container } = render(<ConsoleOutput logs={MANY} errors={{}} />);
		// The row is the wrapper, not the `<pre>`: a line is a level gutter plus a
		// message, and `content-visibility` has to skip the pair or it skips half
		// a row and still lays the other half out.
		const row = container.querySelector("pre")?.parentElement;
		expect(row?.className).toContain("skip-offscreen");
	});

	it("draws no icon per line", () => {
		/*
		 * Every line in a slab came from the script named directly above it, so a
		 * marker on each repeated the heading - and a lucide icon is a
		 * multi-element SVG, which on unbounded output was the dominant per-row
		 * cost.
		 */
		const { container } = render(<ConsoleOutput logs={MANY} errors={{}} />);
		const slab = container.querySelector(".surface-sunken");
		expect(slab).not.toBeNull();
		expect(slab!.querySelectorAll("svg")).toHaveLength(0);
	});
});

describe("the console filter", () => {
	const LOGS = ["[pre] minted token abc", "assertion ran", "[pre] header set"];

	function typeFilter(value: string) {
		const { container } = render(<ConsoleOutput logs={LOGS} errors={{}} />);
		const input = screen.getByLabelText(/filter console output/i);
		fireEvent.change(input, { target: { value } });
		return container;
	}

	it("keeps only matching lines, across both scripts", () => {
		const container = typeFilter("token");
		expect(container.textContent).toContain("minted token abc");
		expect(container.textContent).not.toContain("assertion ran");
		expect(container.textContent).not.toContain("header set");
	});

	it("matches case-insensitively, because log text is not typed twice", () => {
		expect(typeFilter("TOKEN").textContent).toContain("minted token abc");
	});

	it("says so when nothing matches, rather than showing empty sections", () => {
		expect(typeFilter("zzz").textContent).toMatch(/no log matches/i);
	});

	it("searches every line, not the rendered slice", () => {
		/*
		 * The distinction the filter exists to respect. Rendering is progressive,
		 * so filtering what is on screen would search only what you had already
		 * scrolled past - the same trap as searching a virtualised list's DOM.
		 */
		const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
		const { container } = render(<ConsoleOutput logs={many} errors={{}} />);
		expect(container.textContent).not.toContain("line 4999");

		fireEvent.change(screen.getByLabelText(/filter console output/i), {
			target: { value: "line 4999" },
		});
		expect(container.textContent).toContain("line 4999");
	});
});
