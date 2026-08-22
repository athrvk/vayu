/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app draws scrollbars three ways, and they have to be one thickness.
 *
 * The baseline in `index.css` styles every native `overflow` pane; Radix
 * `ScrollArea` draws its bar as real DOM; Monaco renders its own inside the
 * editor and takes a number, not a stylesheet. So the width lives in three
 * files that know nothing about each other, and all three drifted apart the
 * moment they were written - 8px global, shadcn's 10px, Monaco's 14px - while
 * being read side by side, because an editor and a `ScrollArea` and a plain
 * scroll pane routinely sit in the same panel.
 *
 * Each expected width is derived from the CSS rather than written again here,
 * so lowering the baseline without lowering the other two reddens this instead
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
const editor = readFileSync(join(here, "code-editor.tsx"), "utf8");

/**
 * Tailwind's spacing step, which turns `w-1.5` into the px Monaco needs. The
 * theme does not override `--spacing`, so it is the framework default of
 * 0.25rem; if index.css ever declares one, that wins.
 */
const SPACING_PX = (() => {
	const declared = css.match(/--spacing:\s*([\d.]+)rem/);
	return (declared ? Number.parseFloat(declared[1]) : 0.25) * 16;
})();

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
	it("reads all three sources", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(primitive.length).toBeGreaterThan(500);
		expect(editor.length).toBeGreaterThan(500);
	});

	it("gives ScrollArea the same width the native baseline uses", () => {
		const baseline = scrollbarSize("");
		const [width, height] = baseline.split(/\s+/);

		// `w-1.5 h-1.5` - one number, applied to whichever axis the bar runs on.
		expect(width.replace(/^w-/, "")).toBe(height.replace(/^h-/, ""));

		expect(primitive).toContain(`"h-full ${width}"`);
		expect(primitive).toContain(`"${height} flex-col"`);
	});

	it("sizes Monaco's own scrollbars to the same width, in px", () => {
		const [width] = scrollbarSize("").split(/\s+/);
		const px = Number.parseFloat(width.replace(/^w-/, "")) * SPACING_PX;
		expect(px).toBeGreaterThan(0);

		// Monaco takes a number, so this is the one place the width is written
		// as px rather than a class - and the one that cannot be checked by
		// reading a stylesheet at runtime.
		expect(editor).toMatch(new RegExp(`const SCROLLBAR_SIZE = ${px};`));
		expect(editor).toContain("verticalScrollbarSize: SCROLLBAR_SIZE");
		expect(editor).toContain("horizontalScrollbarSize: SCROLLBAR_SIZE");
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
