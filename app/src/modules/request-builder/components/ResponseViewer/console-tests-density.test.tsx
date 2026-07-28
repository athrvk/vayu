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

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";

const RESULTS = [
	{ name: "status is 200", passed: true },
	{ name: "body has id", passed: false, error: "expected undefined to exist" },
];

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

	it("counts each section's own logs", () => {
		// "2 logs" and "1 log" - a shared count would show the same number twice.
		const { container } = consoleOutput();
		expect(container.textContent).toContain("2 logs");
		expect(container.textContent).toContain("1 log");
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
			/\btext-sm\b|\bw-5\b|\bh-5\b/.test(el.className)
		);
		expect(oversized.map((el) => el.className)).toEqual([]);
	});
});

describe("tests density", () => {
	it("sizes its rows to the pane", () => {
		const { container } = render(<TestResults results={RESULTS} />);
		const oversized = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\btext-sm\b|\bw-5\b|\bh-5\b/.test(el.className)
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
