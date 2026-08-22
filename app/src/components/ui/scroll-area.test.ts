/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `ScrollArea` is the app's second scrollbar, and it has to be the same width
 * as the first.
 *
 * The baseline in `index.css` styles every native `overflow` pane; Radix draws
 * its bar as real DOM instead, so the width lives in two files that know
 * nothing about each other. They drifted the moment they were written - 8px
 * global against shadcn's 10px default - and the two are read side by side,
 * because a `ScrollArea` pane sits next to plain scroll panes all over the UI.
 *
 * The expected width is derived from the CSS rather than written twice here,
 * so lowering the baseline without lowering the primitive reddens this instead
 * of shipping a second thickness.
 *
 * Source-scanned, not rendered: vitest stubs CSS imports to `""`, so the
 * stylesheet is only readable off disk - hence the length assertions, which
 * exist so an empty read cannot pass the file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "..", "index.css"), "utf8");
const primitive = readFileSync(join(here, "scroll-area.tsx"), "utf8");

/**
 * The `@apply` line of a `::-webkit-scrollbar` rule, by its selector prefix.
 * The empty prefix means the baseline, so it requires whitespace ahead of the
 * pseudo-element - otherwise it would happily match `.scrollbar-strip`'s.
 */
function scrollbarSize(selector: string): string {
	const prefix = selector === "" ? "\\s" : selector;
	const m = css.match(new RegExp(`${prefix}::-webkit-scrollbar\\s*\\{\\s*@apply ([^;]+);`));
	if (!m) throw new Error(`no ::-webkit-scrollbar rule for "${selector || "the baseline"}"`);
	return m[1].trim();
}

/** The class list of the Radix thumb element. */
function thumbClasses(): string {
	const m = primitive.match(/ScrollAreaThumb\s+className="([^"]*)"/);
	if (!m) throw new Error("no ScrollAreaThumb className in scroll-area.tsx");
	return m[1];
}

describe("scrollbar width", () => {
	it("reads both sources", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(primitive.length).toBeGreaterThan(500);
	});

	it("gives ScrollArea the same width the native baseline uses", () => {
		const baseline = scrollbarSize("");
		const [width, height] = baseline.split(/\s+/);

		// `w-1.5 h-1.5` - one number, applied to whichever axis the bar runs on.
		expect(width.replace(/^w-/, "")).toBe(height.replace(/^h-/, ""));

		expect(primitive).toContain(`"h-full ${width}"`);
		expect(primitive).toContain(`"${height} flex-col"`);
	});

	it("keeps the ScrollArea thumb on the baseline's colour", () => {
		// `--border` is the same colour as `--card` in dark, so the shadcn
		// default (`bg-border`) is an invisible thumb on the surface this
		// component is usually laid over.
		expect(thumbClasses()).toContain("bg-muted-foreground/30");
		expect(thumbClasses()).not.toContain("bg-border");
	});

	/*
	 * Not a style preference: a scroller that declares either standard property
	 * makes Chromium ignore every ::-webkit-scrollbar rule on it, so one such
	 * declaration outside the guard turns the whole block above into decoration
	 * and the bar renders at Chromium's `thin` - which is wider than the file
	 * says, and is what this issue was reported as.
	 */
	it("declares the standard scrollbar properties only behind the @supports guard", () => {
		// Comments discuss both properties by name, colon and all. Blank them
		// out rather than matching them - keeping the offsets, so the positions
		// below still line up with the real file.
		const rules = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));

		const open = rules.indexOf("@supports not selector(::-webkit-scrollbar)");
		expect(open).toBeGreaterThan(-1);

		let depth = 0;
		let close = rules.indexOf("{", open);
		for (let i = close; i < rules.length; i++) {
			if (rules[i] === "{") depth++;
			else if (rules[i] === "}" && --depth === 0) {
				close = i;
				break;
			}
		}

		const declarations = [...rules.matchAll(/scrollbar-(?:width|color)\s*:/g)];
		expect(declarations.length).toBeGreaterThan(0);
		for (const d of declarations) {
			expect(d.index).toBeGreaterThan(open);
			expect(d.index).toBeLessThan(close);
		}
	});

	it("keeps the tab-strip override narrower than the baseline it overrides", () => {
		const strip = scrollbarSize("\\.scrollbar-strip");
		const size = (v: string) => Number.parseFloat(v.replace(/^[wh]-/, ""));

		expect(size(strip.split(/\s+/)[0])).toBeLessThan(size(scrollbarSize("").split(/\s+/)[0]));
	});
});
