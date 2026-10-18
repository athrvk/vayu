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
 * The heading step belongs to the primitive that draws the heading (#1202).
 *
 * `CardTitle` shipped `font-semibold leading-none tracking-tight` and no size,
 * so every one of the app's 51 card headings supplied one - 45 `text-base`, 6
 * `text-lg` - and a settings panel heading rendered 16px against 13px body,
 * three steps up in a tool whose whole register is 12-15px. Sweeping the call
 * sites without giving the primitive a size would have left the next card
 * heading to pick one again.
 *
 * Rendered rather than scanned, per app/CLAUDE.md: these classes arrive through
 * `cn()`, so a source scan sees the base string and not what a caller composed
 * with it. The scan half - that no call site writes a size above the step - is
 * `type-scale.test.ts`; neither half covers the other.
 *
 * The render above cannot see a call site that overrides the step: it renders
 * the primitive with no className, while `cn()` is tailwind-merge and lets the
 * caller win. Import's title was `text-sm font-bold` for that reason and read
 * 13px bold beside every other dialog's 15px semibold (#2316). The last block
 * scans for the call sites.
 */

import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";

import { openingTags, ownClassName } from "@/lib/jsx-opening-tags.testkit";

import { Card, CardHeader, CardTitle } from "./card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./dialog";
import { Input } from "./input";

describe("the heading primitives carry the title step", () => {
	it("CardTitle renders 15px without being told to", () => {
		render(
			<Card>
				<CardHeader>
					<CardTitle>Load test ceilings</CardTitle>
				</CardHeader>
			</Card>
		);
		const title = screen.getByText("Load test ceilings");
		expect(title.className).toContain("text-md");
		expect(title.className).not.toMatch(/\btext-(base|lg)\b/);
	});

	it("a caller's own classes compose with the step rather than replacing it", () => {
		// The shape half the swept call sites had: a layout class beside the
		// size. Dropping the size has to leave the primitive's showing.
		render(
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">Error Summary</CardTitle>
				</CardHeader>
			</Card>
		);
		const title = screen.getByText("Error Summary");
		expect(title.className).toContain("text-md");
		expect(title.className).toContain("flex");
	});

	it("DialogTitle renders the same step, not stock shadcn's 18px", () => {
		render(
			<Dialog open>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Import collection</DialogTitle>
						<DialogDescription>Pick a file to read.</DialogDescription>
					</DialogHeader>
				</DialogContent>
			</Dialog>
		);
		const title = screen.getByText("Import collection");
		expect(title.className).toContain("text-md");
		expect(title.className).not.toMatch(/\btext-lg\b/);
	});

	it("Input renders body size at every window width", () => {
		// `text-base md:text-sm` rendered 16px below the `md` breakpoint - a
		// split window or a narrow pane - which is not a size the scale has.
		render(<Input aria-label="Request name" />);
		const input = screen.getByLabelText("Request name");
		expect(input.className).toContain("text-sm");
		expect(input.className).not.toMatch(/\bmd:text-|\btext-base\b/);
	});
});

describe("no DialogTitle names its own size or weight", () => {
	const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const sources = globSync("**/*.tsx", { cwd: srcRoot })
		.map((file) => file.split(sep).join("/"))
		.filter((file) => !/\.(test|testkit)\.tsx$/.test(file))
		.map((file) => ({ file, code: readFileSync(join(srcRoot, file), "utf8") }));
	const titles = sources.flatMap(({ file, code }) =>
		openingTags(code, "DialogTitle").map((tag) => ({ file, className: ownClassName(tag) }))
	);

	it("scans the app's source and finds the primitive's users", () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(titles.length).toBeGreaterThan(10);
		expect(titles.some(({ className }) => className.includes("sr-only"))).toBe(true);
	});

	it("passes no text- or font- class other than sr-only", () => {
		const offenders = titles
			.filter(({ className }) =>
				/\b(?:text|font)-/.test(className.replace(/\bsr-only\b/g, ""))
			)
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});
});
