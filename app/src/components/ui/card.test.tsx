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
 * `Card` declares its own surface (#2294).
 *
 * `--border` is the same colour as `--card` in dark, so a divider inside a card
 * that falls back to it is invisible. `surface-card` declares the `--rule` that
 * `border-rule` reads, and it belongs to the primitive so no call site has to
 * remember it. The inverse mistake is a divider written as a border token
 * inside a Card, which skips the declared rule: the scan below refuses it.
 *
 * Mutation-check: drop `surface-card` from `card.tsx` and the render cases
 * fail; put `border-border` back on `AppearancePanel.tsx`'s Reduced motion
 * divider and the scan fails.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { stripComments } from "@/lib/strip-comments.testkit";
import { Card } from "./card";

const sources: Record<string, string> = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * A border token other than `border-border-strong`, with or without a side
 * (`border-t-border`) or a variant prefix (`dark:border-border`).
 * `border-border-strong` is a deliberate pick; the bare token is the canvas
 * colour, which is the card's own colour in dark.
 */
const CANVAS_BORDER_CLASS = /(?<![\w-])(?:[\w[\]=&>-]+:)*border(?:-[trblxyse])?-border(?![\w-])/g;

const CARD_TOKEN = /<Card(?=[\s>])|<\/Card>/g;

/** The source between each outermost `<Card` and its matching `</Card>`. */
function cardSpans(source: string): string[] {
	const spans: string[] = [];
	let depth = 0;
	let start = 0;
	for (const match of source.matchAll(CARD_TOKEN)) {
		if (match[0] === "</Card>") {
			depth -= 1;
			if (depth === 0) spans.push(source.slice(start, match.index + match[0].length));
			continue;
		}
		if (depth === 0) start = match.index;
		depth += 1;
	}
	// An unbalanced file means a self-closing `<Card />` or a stray tag, and the
	// spans after it would be wrong rather than missing.
	expect(depth, "unbalanced <Card> tags").toBe(0);
	return spans;
}

describe("Card declares its surface", () => {
	it("carries the bg-card surface-card pair", () => {
		const { container } = render(<Card />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.classList.contains("bg-card")).toBe(true);
		expect(root.classList.contains("surface-card")).toBe(true);
	});

	it("keeps the surface when the caller adds a class", () => {
		const { container } = render(<Card className="x" />);
		const root = container.firstElementChild as HTMLElement;
		expect(root.classList.contains("x")).toBe(true);
		expect(root.classList.contains("bg-card")).toBe(true);
		expect(root.classList.contains("surface-card")).toBe(true);
	});
});

describe("Card pad", () => {
	const root = (ui: React.ReactElement) => render(ui).container.firstElementChild as HTMLElement;

	it("sm pads p-3 and md pads p-4", () => {
		expect(root(<Card pad="sm" />).classList.contains("p-3")).toBe(true);
		expect(root(<Card pad="md" />).classList.contains("p-4")).toBe(true);
	});

	it("names no padding without pad, so CardHeader and CardContent keep theirs", () => {
		const classes = Array.from(root(<Card />).classList);
		expect(classes.filter((c) => /^p[xytrbl]?-/.test(c))).toEqual([]);
	});

	it("does not forward pad to the DOM", () => {
		expect(root(<Card pad="sm" />).hasAttribute("pad")).toBe(false);
	});

	it("lets a caller class override the pad", () => {
		expect(root(<Card pad="md" className="p-6" />).className).not.toContain("p-4");
	});
});

describe("no divider inside a Card reads a canvas border token", () => {
	const files = Object.entries(sources).filter(([path]) => !path.includes(".test."));
	const withCards = files.filter(([, src]) => new RegExp(CARD_TOKEN.source).test(src));

	it("scans a real set of files (guards the scan itself)", () => {
		expect(files.length).toBeGreaterThan(100);
		expect(withCards.length).toBeGreaterThan(30);
	});

	it("writes border-rule, or border-border-strong, between a <Card and its </Card>", () => {
		const offenders: string[] = [];
		for (const [path, src] of withCards) {
			for (const span of cardSpans(stripComments(src))) {
				for (const hit of span.matchAll(CANVAS_BORDER_CLASS))
					offenders.push(`${path}: ${hit[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the pattern separates the canvas token from the strong one", () => {
		const hits = (s: string) => s.match(CANVAS_BORDER_CLASS) ?? [];
		expect(hits('"border border-border"')).toEqual(["border-border"]);
		expect(hits('"border-t-border pt-4"')).toEqual(["border-t-border"]);
		expect(hits('"dark:border-border"')).toEqual(["dark:border-border"]);
		expect(hits('"border-border-strong"')).toEqual([]);
		expect(hits('"border-rule border-b-0"')).toEqual([]);
	});
});
