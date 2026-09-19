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
 * The `Icon motion` block of `index.css`, and the call sites that opt into it.
 *
 * The block is a set of rules nothing in the app can typecheck, addressing
 * paths inside a glyph a dependency draws. Four things can rot silently, and
 * each has a case below.
 *
 * 1. **A rule that is always on.** Drop the `:hover` from a trigger selector
 *    and the icon simply sits rotated forever - it renders, it looks like a
 *    design choice, and no snapshot has an opinion. Every rule that sets a
 *    transform or an animation has to be gated on an interaction.
 * 2. **A missing `transform-box: fill-box`.** The initial reference box for an
 *    SVG element's transform is the `view-box`, so `transform-origin: 0% 50%`
 *    resolves against the 24x24 canvas rather than the path, and the lid hinges
 *    about a point outside the can. The wrong-but-plausible result is exactly
 *    the failure mode a human reviewer reading the diff cannot see.
 * 3. **A hardcoded duration or curve.** The motion vocabulary exists so the app
 *    reads as one hand; a `120ms` here is how that stops being true.
 * 4. **A glyph redrawn upstream.** `> path:nth-child(4)` is only "the lid" for
 *    as long as lucide draws Trash2 with the lid fourth. The glyph renders, so
 *    the index is checkable against the real children rather than trusted: a
 *    redraw fails here instead of animating the tines.
 *
 * Read from disk rather than imported: vitest stubs CSS imports to an empty
 * string unless `test.css` is enabled, so every assertion here would otherwise
 * have passed against "" - see `reduced-motion.test.ts`.
 *
 * jsdom, because the glyph indices the stylesheet pins are read off a real
 * render: `nth-child` counts the children of the `svg` a browser sees, which is
 * the one thing a render cannot be wrong about. The call sites that opt into
 * these rules are guarded a file over, in `icon-motion.call-sites.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import {
	ChevronDown,
	ChevronRight,
	Plus,
	RefreshCw,
	Trash2,
	X,
	type LucideIcon,
} from "lucide-react";
import { ICON_MOTION } from "./icon-motion";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

/** The block, from its own banner to the `@layer` that follows it. */
const block = (() => {
	const banner = css.indexOf("── Icon motion ──");
	expect(banner, "the Icon motion banner has moved or gone").toBeGreaterThan(-1);
	// From the `/*` that opens the banner's own comment, not from the banner
	// text: starting mid-comment leaves the comment stripper below pairing
	// `/* … */` one delimiter out of step, which inverts it - it then deletes
	// the code and keeps the prose, and every assertion reads the comments.
	const start = css.lastIndexOf("/*", banner);
	expect(start, "the Icon motion banner is not inside a comment").toBeGreaterThan(-1);
	const end = css.indexOf("\n@layer", start);
	expect(end, "expected a @layer after the Icon motion block").toBeGreaterThan(start);
	return css.slice(start, end);
})();

/** Comment-free, so a sentence about `150ms` is not read as a declaration. */
const code = block.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
	readonly selectors: readonly string[];
	readonly body: string;
}

/**
 * One selector list into its selectors. Paren-aware: every trigger here is
 * `:where(a, b):is(c, d)`, so a plain `split(",")` tears each rule into
 * fragments that gate on nothing and the guards below all pass vacuously.
 */
function splitSelectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of list) {
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * The block's top-level rules. `@keyframes` bodies are nested, so they are
 * skipped by brace depth rather than by name - a future `@supports` or
 * `@media` wrapper would be skipped the same way instead of being mis-parsed.
 */
const rules: Rule[] = (() => {
	const out: Rule[] = [];
	let head = "";
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		if (ch === "{") {
			let depth = 1;
			let j = i + 1;
			while (j < code.length && depth > 0) {
				if (code[j] === "{") depth++;
				else if (code[j] === "}") depth--;
				j++;
			}
			const selector = head.trim();
			if (selector && !selector.startsWith("@")) {
				out.push({
					selectors: splitSelectors(selector),
					body: code.slice(i + 1, j - 1),
				});
			}
			head = "";
			i = j;
			continue;
		}
		if (ch === "}") {
			head = "";
			i++;
			continue;
		}
		head += ch;
		i++;
	}
	return out;
})();

/** Sets a transform or an animation - i.e. actually moves the glyph. */
const MOVES = /(?:^|[;{\s])(rotate|translate|scale|transform|animation)\s*:/;
/** An interaction gate. `[data-state`/`aria-pressed` cover a state change. */
const GATED = /:hover|:focus-visible|\[data-state|aria-pressed/;

describe("icon motion: the stylesheet block", () => {
	it("reads a stylesheet and a block that are actually there (guards the scan)", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(block.length).toBeGreaterThan(500);
		expect(rules.length).toBeGreaterThan(5);
		// Every name the type exports has rules, and nothing here is vacuous.
		for (const name of Object.values(ICON_MOTION)) {
			expect(code, `no rule for data-icon-motion="${name}"`).toContain(
				`[data-icon-motion="${name}"]`
			);
		}
	});

	it("gates every rule that moves a glyph on hover, focus-visible or a state", () => {
		const alwaysOn = rules
			.filter((r) => MOVES.test(r.body))
			.filter((r) => !r.selectors.every((s) => GATED.test(s)))
			.flatMap((r) => r.selectors);
		expect(alwaysOn.join("\n")).toBe("");
	});

	it("triggers from the owning button or group, never the icon's own hover", () => {
		for (const rule of rules.filter((r) => MOVES.test(r.body))) {
			for (const selector of rule.selectors) {
				// The gate has to sit on the owner, which is everything before
				// the `[data-icon-motion=…]` the rule addresses.
				const owner = selector.slice(0, selector.indexOf("[data-icon-motion="));
				expect(owner, `${selector} gates on the icon, not its owner`).toMatch(GATED);
				expect(owner, `${selector} does not trigger from a button or a group`).toMatch(
					/\[data-slot="button"\]|\.group/
				);
			}
		}
	});

	it("declares a transform-origin for every target it moves, and fill-box for every child", () => {
		/** Declarations for one target, gathered from every rule naming it. */
		const byTarget = new Map<string, string>();
		for (const rule of rules) {
			for (const selector of rule.selectors) {
				const at = selector.indexOf("[data-icon-motion=");
				if (at === -1) continue;
				const target = selector.slice(at);
				byTarget.set(target, (byTarget.get(target) ?? "") + rule.body);
			}
		}
		expect(byTarget.size).toBeGreaterThan(4);

		for (const [target, body] of byTarget) {
			if (!MOVES.test(body)) continue;
			expect(body, `${target} moves without an explicit transform-origin`).toMatch(
				/transform-origin:\s*\S/
			);
			// `fill-box` is what makes a percentage origin resolve against the
			// path rather than the 24x24 canvas, so it is required exactly where
			// the rule addresses a child. On the root `svg` the reference box is
			// the element's own box either way, measured: `50% 50%` computes to
			// the frame's centre with or without it, so requiring it there would
			// be requiring a declaration that does nothing.
			if (!/>\s*(path|circle|rect|line|polyline|polygon|g)\b/.test(target)) continue;
			expect(body, `${target} moves a child without transform-box: fill-box`).toContain(
				"transform-box: fill-box"
			);
		}
	});

	it("takes every duration and curve from a token, never a literal", () => {
		// No time literal anywhere in the block's code, and no hand-written
		// curve: `0.98`-style numbers are fine, `120ms` and `cubic-bezier(` are
		// what a token exists to prevent.
		expect(code).not.toMatch(/\b\d+(?:\.\d+)?m?s\b/);
		expect(code).not.toContain("cubic-bezier(");
		expect(code).not.toContain("ease-in-out");

		// And every timing that is there resolves to one of the two families.
		const timings = [...code.matchAll(/(?:transition|animation):([^;]+);/g)].map((m) => m[1]);
		expect(timings.length).toBeGreaterThan(3);
		for (const value of timings) {
			for (const ref of value.match(/var\(--[a-z0-9-]+/g) ?? []) {
				expect(ref, `${value.trim()} reads a non-token value`).toMatch(
					/var\(--(dur|ease)-|var\(--icon-motion-duration/
				);
			}
		}
		// The one indirection is itself a token reference.
		expect(code).toMatch(/--icon-motion-duration:\s*var\(--dur-[a-z-]+\)/);
	});

	it("never reads --tw-duration, which a .motion-menu ancestor sets", () => {
		expect(code).not.toContain("--tw-duration");
		expect(code).not.toContain("--tw-ease");
	});

	it("carries no will-change", () => {
		expect(code).not.toContain("will-change");
	});
});

describe("icon motion: the nth-child indices lucide's glyphs justify", () => {
	/**
	 * What lucide actually renders for one icon, child by child: `tagName` and
	 * the path data. Rendered rather than read from the package's exported
	 * `__iconNode`, because `nth-child` counts the children of the `svg` the
	 * browser sees - which is what this has to pin, and the one thing a render
	 * cannot be wrong about.
	 */
	function children(Icon: LucideIcon): { tag: string; d: string }[] {
		const { container } = render(<Icon />);
		const svg = container.querySelector("svg");
		expect(svg, "lucide rendered no svg").not.toBeNull();
		return [...(svg?.children ?? [])].map((child) => ({
			tag: child.tagName.toLowerCase(),
			d: child.getAttribute("d") ?? "",
		}));
	}

	/** Every `> path:nth-child(N)` the block names for one motion. */
	function indices(name: string): number[] {
		const found = [
			...code.matchAll(
				new RegExp(`\\[data-icon-motion="${name}"\\]\\s*> path:nth-child\\((\\d+)\\)`, "g")
			),
		].map((m) => Number(m[1]));
		return [...new Set(found)].sort((a, b) => a - b);
	}

	it("names the lid bar and its handle, not the tines or the can", () => {
		const trash = children(Trash2);
		// What the rule means, stated as path data rather than as a position:
		// the lid bar and the handle that sits on it. `+ 1` because `nth-child`
		// is 1-based.
		const lid = trash.findIndex((c) => c.d === "M3 6h18") + 1;
		const handle = trash.findIndex((c) => c.d.startsWith("M8 6V4")) + 1;
		expect(lid, "lucide no longer draws Trash2's lid bar as `M3 6h18`").toBeGreaterThan(0);
		expect(handle, "lucide no longer draws Trash2's lid handle").toBeGreaterThan(0);
		expect(indices(ICON_MOTION.lid)).toEqual([lid, handle].sort((a, b) => a - b));
	});

	it("addresses paths, and only paths, in every icon it targets", () => {
		// `nth-child` counts every child, so a `circle` or a `g` appearing in
		// one of these glyphs would shift the index the lid rule pins above -
		// and for the whole-svg motions it would be the moment a child-level
		// rule became possible to get wrong.
		const icons: Record<string, LucideIcon> = {
			Trash2,
			RefreshCw,
			Plus,
			X,
			ChevronRight,
			ChevronDown,
		};
		for (const [name, Icon] of Object.entries(icons)) {
			const kids = children(Icon);
			expect(kids.length, `${name} rendered no children`).toBeGreaterThan(0);
			for (const { tag } of kids) {
				expect(tag, `${name} now draws a <${tag}>, so nth-child indices shift`).toBe(
					"path"
				);
			}
		}
	});

	it("moves the whole svg wherever it names no child", () => {
		// The four whole-glyph motions must not have grown a child selector
		// without gaining the per-child origin reasoning the lid rule carries.
		for (const name of [
			ICON_MOTION.spinOnce,
			ICON_MOTION.rotate90,
			ICON_MOTION.nudgeX,
			ICON_MOTION.nudgeY,
		]) {
			expect(indices(name), `${name} now addresses a child path`).toEqual([]);
		}
	});
});
