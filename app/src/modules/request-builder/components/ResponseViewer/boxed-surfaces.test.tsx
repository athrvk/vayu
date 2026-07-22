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
 * The response pane's boxed surfaces.
 *
 * `--radius` is user-controlled (Settings → Appearance → Roundedness), and
 * `radius-token.test.tsx` already guards one way to escape it: a bare `rounded`,
 * which Tailwind pins at 4px forever. The other way is to carry no radius class
 * at all, which pins the box at 0 instead - and that is not something a source
 * scan can flag, because plenty of surfaces are square on purpose (the response
 * header bar, the tab strips, the full-bleed editors). Only the component knows
 * which it is, so these render it and read the real class list.
 *
 * Five boxes here had no radius: both script-error cards, both console log
 * slabs, and every test-result row. A user who chose Rounded got square corners
 * in the one pane they look at after every send.
 *
 * The log slabs also lost `border border-border`. Measured against `--muted`,
 * that border is **1.16** in dark and **1.11** in light - no visible edge.
 * `--border-strong` does not rescue it either: in dark, `--muted` (L 16%) sits
 * *between* `--border` (L 10%) and `--border-strong` (L 18%), so the stronger
 * token is fainter still at 1.107. The `bg-muted` fill separates from the card
 * on its own at 1.149, which is the treatment the script panels' Quick Reference
 * slabs have always used.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import ClientErrorView from "./ClientErrorView";

/**
 * Every element carrying a background or border class, i.e. the things that read
 * as a "box". Text and layout wrappers are not boxes and are not checked.
 */
function boxes(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
		/\b(bg-(muted|destructive|status)|border-(destructive|status))/.test(el.className)
	);
}

/** `rounded-sm|md|lg|full` - anything that tracks the setting, or a deliberate circle. */
const HAS_RADIUS = /\brounded-(sm|md|lg|full)\b/;

describe("console output", () => {
	const rendered = () =>
		render(
			<ConsoleOutput
				logs={["[pre] setting up", "assertion passed"]}
				errors={{ pre: "ReferenceError: x is not defined", post: "AssertionError" }}
			/>
		);

	it("renders the surfaces this test is about (guards the scan itself)", () => {
		const { container } = rendered();
		// Two error cards, two log slabs, plus the chevron pucks and count badges.
		expect(boxes(container).length).toBeGreaterThanOrEqual(4);
	});

	it("gives every boxed surface a radius that follows the setting", () => {
		const { container } = rendered();
		const square = boxes(container).filter((el) => !HAS_RADIUS.test(el.className));
		expect(square.map((el) => el.className)).toEqual([]);
	});

	it("does not outline the log slabs with a border that cannot be seen", () => {
		const { container } = rendered();
		const slabs = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\bbg-muted\b/.test(el.className)
		);

		expect(slabs.length).toBe(2); // one per script source
		for (const slab of slabs) {
			expect(slab.className).not.toMatch(/\bborder-border(-strong)?\b/);
		}
	});

	it("keeps the error cards' border, which has hue and does read", () => {
		const { container } = rendered();
		const cards = Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\bbg-destructive\/10\b/.test(el.className)
		);

		expect(cards.length).toBe(2); // pre-request and test
		for (const card of cards) {
			expect(card.className).toMatch(/border-destructive/);
		}
	});
});

describe("test results", () => {
	const rendered = () =>
		render(
			<TestResults
				results={[
					{ name: "status is 200", passed: true },
					{ name: "body has id", passed: false, error: "expected undefined to exist" },
				]}
			/>
		);

	it("renders one row per result (guards the scan itself)", () => {
		const { container } = rendered();
		expect(boxes(container).length).toBeGreaterThanOrEqual(2);
	});

	it("rounds the pass row and the fail row alike", () => {
		const { container } = rendered();
		const square = boxes(container).filter((el) => !HAS_RADIUS.test(el.className));
		expect(square.map((el) => el.className)).toEqual([]);
	});
});

describe("client error view", () => {
	it("marks its tip with an icon, not an emoji", () => {
		const { container } = render(<ClientErrorView errorCode="TIMEOUT" />);

		// The 💡 was the only emoji in modules/. It rendered in the OS emoji font
		// beside 12px muted text, at a size and baseline nothing in the app set.
		expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
		expect(container.querySelector("svg.lucide-lightbulb")).toBeTruthy();
	});

	it("still shows the hint the icon introduces", () => {
		const { container } = render(<ClientErrorView errorCode="TIMEOUT" />);
		expect(container.textContent).toContain("Try increasing the request timeout");
	});
});
