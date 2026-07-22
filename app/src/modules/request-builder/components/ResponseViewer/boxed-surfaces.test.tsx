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
 * The log slabs also lost `border border-border`. Measured in the running app,
 * no border token outlines a `bg-muted` box in both themes:
 *
 *                                  light    dark
 *     --border       on --muted    1.105    1.157
 *     --border-strong on --muted   1.317    1.108
 *
 * `--border-strong` does not rescue it - in dark it is the fainter of the two,
 * because `--muted` (L 16%) sits between `--border` (L 10%) and
 * `--border-strong` (L 18%). The `bg-muted` fill separates from the card on its
 * own at 1.180 light / 1.153 dark, which is the treatment the script panels'
 * Quick Reference slabs have always used.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import ClientErrorView from "./ClientErrorView";
import ResponseHeader from "./ResponseHeader";
import ResponseCookies from "./ResponseCookies";

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

/**
 * Dividers in this pane say `border-rule` and let the enclosing surface decide
 * what that resolves to - `--border` on a card in light (1.304),
 * `--border-strong` in dark, where `--border` is 1.003, the same colour as the
 * card. Three dividers here had never been converted at all: the status bar had
 * no bottom edge, the tab strip did not separate from the body, and the cookie
 * table ran together as one block (its row rule was `border-border/50`, which
 * composites to 1.002).
 *
 * These assert the *leaf* half of the contract. The half that can silently
 * revert - a surface root forgetting to declare `--rule` - is pinned in
 * `shared/response-viewer/surface-rule.test.tsx`, because `border-rule` being
 * present proves nothing on its own.
 */
describe("dividers inside the response card", () => {
	/** Anything drawing a rule: the elements whose border is their only edge. */
	const rules = (container: HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>("*")).filter((el) =>
			/\bborder-(b|t|y)?-?(rule|border)\b/.test(el.className)
		);

	it("gives the status bar a bottom edge", () => {
		const { container } = render(
			<ResponseHeader response={{ status: 200, statusText: "OK", time: 120, size: 2048 }} />
		);
		const bar = container.firstElementChild as HTMLElement;

		expect(bar.className).toMatch(/\bborder-b\b/);
		expect(bar.className).toMatch(/\bborder-rule\b/);
	});

	it("rules the cookie table through the surface, not a hardcoded token", () => {
		const { container } = render(
			<ResponseCookies headers={{ "set-cookie": "session=abc; Path=/" }} />
		);
		const ruled = rules(container);

		// A header rule and at least one row rule.
		expect(ruled.length).toBeGreaterThanOrEqual(2);
		for (const el of ruled) {
			expect(el.className).toMatch(/\bborder-rule\b/);
			// Any alpha would re-open the gap: `/50` on a card lands at 1.002.
			expect(el.className).not.toMatch(/border-(rule|border(-strong)?)\/\d/);
		}
	});
});

describe("client error view", () => {
	it("marks its tip with an icon, not an emoji", () => {
		const { container } = render(<ClientErrorView errorCode="TIMEOUT" />);

		// The light-bulb emoji this replaced was the only one in modules/. It
		// rendered in the OS emoji font beside 12px muted text, at a size and
		// baseline nothing in the app controlled. Asserted by category rather
		// than by that one codepoint, so no emoji creeps back in here.
		expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
		expect(container.querySelector("svg.lucide-lightbulb")).toBeTruthy();
	});

	it("still shows the hint the icon introduces", () => {
		const { container } = render(<ClientErrorView errorCode="TIMEOUT" />);
		expect(container.textContent).toContain("Try increasing the request timeout");
	});
});
