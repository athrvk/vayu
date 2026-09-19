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
	Activity,
	Bell,
	Braces,
	ChevronDown,
	ChevronRight,
	Clock,
	Code,
	CodeXml,
	Database,
	Download,
	Gauge,
	Info,
	LayoutDashboard,
	Network,
	Plug,
	FolderOpen,
	Pin,
	Play,
	Plus,
	Radio,
	RefreshCw,
	RotateCcw,
	Save,
	Search,
	Trash2,
	Upload,
	Zap,
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

/** Sets a transform property directly - not via an animation. */
const TRANSFORMS = /(?:^|[;{\s])(rotate|translate|scale|transform)\s*:/;

/** The body of one `@keyframes` block in the stripped code, by name. */
function keyframeBody(name: string): string {
	const at = code.indexOf(`@keyframes ${name}`);
	if (at === -1) return "";
	const open = code.indexOf("{", at);
	let depth = 1;
	let i = open + 1;
	while (i < code.length && depth > 0) {
		if (code[i] === "{") depth++;
		else if (code[i] === "}") depth--;
		i++;
	}
	return code.slice(open + 1, i - 1);
}

/**
 * Whether these declarations end up transforming the element - directly, or
 * through the keyframes of an animation they name. An animation that only
 * changes `opacity` or a stroke dash moves no coordinate system and has no
 * origin to get wrong.
 */
function transformsSomething(body: string): boolean {
	if (TRANSFORMS.test(body)) return true;
	for (const match of body.matchAll(/animation:\s*([a-z0-9-]+)/g)) {
		if (TRANSFORMS.test(keyframeBody(match[1]))) return true;
	}
	return false;
}

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

	it("declares a transform-origin for every target it transforms, and fill-box for every child", () => {
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

		let required = 0;
		for (const [target, body] of byTarget) {
			// What actually needs an origin is a *transform*. An `animation:`
			// needs one too, but only when its keyframes transform - and that
			// is the half a body cannot answer on its own, because the
			// transform is written in the `@keyframes` block rather than here.
			// So the animation's keyframes are looked up and read. Before this,
			// `trace` - which animates `stroke-dashoffset` and moves nothing -
			// would have been made to declare an origin that does nothing, and
			// a rule whose keyframes rotate while its own body is bare would
			// have passed on a technicality.
			if (!transformsSomething(body)) continue;
			required++;
			expect(body, `${target} transforms without an explicit transform-origin`).toMatch(
				/transform-origin:\s*\S/
			);
			// `fill-box` is what makes a percentage origin resolve against the
			// shape rather than the 24x24 canvas, so it is required exactly
			// where the rule addresses a child. On the root `svg` the reference
			// box is the element's own box either way, measured: `50% 50%`
			// computes to the frame's centre with or without it, so requiring
			// it there would be requiring a declaration that does nothing.
			if (!/>\s*(path|circle|rect|ellipse|line|polyline|polygon|g)\b/.test(target)) continue;
			expect(body, `${target} transforms a child without transform-box: fill-box`).toContain(
				"transform-box: fill-box"
			);
		}
		expect(required, "nothing was found to transform, so this proves nothing").toBeGreaterThan(
			10
		);
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

/**
 * Which lucide glyph each motion is written for, so the indices below are
 * checked against the right drawing. A motion that moves the whole `svg` is
 * here too: the "moves the whole svg" case asserts it names no child, and the
 * "addresses paths" case needs the glyph to look at either way.
 */
const MOTION_GLYPH: Record<string, LucideIcon> = {
	[ICON_MOTION.lid]: Trash2,
	[ICON_MOTION.hands]: Clock,
	[ICON_MOTION.waves]: Radio,
	[ICON_MOTION.spread]: Braces,
	[ICON_MOTION.tilt]: FolderOpen,
	[ICON_MOTION.wiggle]: Search,
	[ICON_MOTION.drop]: Download,
	[ICON_MOTION.lift]: Upload,
	[ICON_MOTION.press]: Save,
	[ICON_MOTION.tiltPin]: Pin,
	[ICON_MOTION.ring]: Bell,
	[ICON_MOTION.bob]: Info,
	[ICON_MOTION.part]: CodeXml,
	[ICON_MOTION.tiles]: LayoutDashboard,
	[ICON_MOTION.sweep]: Gauge,
	[ICON_MOTION.plugIn]: Plug,
	[ICON_MOTION.pulse]: Network,
	[ICON_MOTION.trace]: Activity,
	[ICON_MOTION.stack]: Database,
	[ICON_MOTION.spinOnce]: RefreshCw,
	[ICON_MOTION.spinBack]: RotateCcw,
	[ICON_MOTION.flash]: Zap,
	[ICON_MOTION.rotate90]: Plus,
	[ICON_MOTION.nudgeX]: ChevronRight,
	[ICON_MOTION.nudgeY]: ChevronDown,
	[ICON_MOTION.scale]: Play,
};

/**
 * The motions whose ink leaves the 24-unit viewBox, from the "Leaves the
 * frame" column of the table in docs/design-system.md. An inline `svg` clips
 * to its viewBox (`overflow: hidden` is the UA value for an svg root in HTML),
 * so each of these has to say `overflow: visible` or the travel is simply cut
 * off - and cut off silently, at every call site at once.
 */
const FRAME_LEAVING = [
	ICON_MOTION.lid,
	ICON_MOTION.waves,
	ICON_MOTION.tilt,
	ICON_MOTION.lift,
	ICON_MOTION.tiltPin,
	ICON_MOTION.ring,
	ICON_MOTION.bob,
	ICON_MOTION.part,
	ICON_MOTION.plugIn,
	ICON_MOTION.stack,
] as const;

describe("icon motion: the nth-child indices lucide's glyphs justify", () => {
	/**
	 * What lucide actually renders for one icon, child by child: `tagName` and
	 * the path data. Rendered rather than read from the package's exported
	 * `__iconNode`, because `nth-child` counts the children of the `svg` the
	 * browser sees - which is what this has to pin, and the one thing a render
	 * cannot be wrong about.
	 */
	function children(Icon: LucideIcon): { tag: string; d: string; at: string }[] {
		const { container } = render(<Icon />);
		const svg = container.querySelector("svg");
		expect(svg, "lucide rendered no svg").not.toBeNull();
		return [...(svg?.children ?? [])].map((child) => ({
			tag: child.tagName.toLowerCase(),
			d: child.getAttribute("d") ?? "",
			// Where a shape sits, for the children that carry no `d`: a `rect`
			// is named by its corner and an `ellipse` by its centre, which is
			// how the rules below say which tile or which disc they mean.
			at: [
				child.getAttribute("x") ?? child.getAttribute("cx") ?? "",
				child.getAttribute("y") ?? child.getAttribute("cy") ?? "",
			].join(","),
		}));
	}

	/**
	 * Every `> <tag>:nth-child(N)` the block names for one motion, as
	 * `[index, tag]`.
	 *
	 * The tag is read rather than assumed to be `path`: lucide draws `rect`s
	 * for LayoutDashboard and Network, an `ellipse` for Database and `circle`s
	 * for Clock and Radio, so a rule that names the wrong element type matches
	 * nothing while looking exactly like one that works.
	 */
	function targets(name: string): [index: number, tag: string][] {
		const found = [
			...code.matchAll(
				new RegExp(
					`\\[data-icon-motion="${name}"\\]\\s*> ([a-z]+):nth-child\\((\\d+)\\)`,
					"g"
				)
			),
		].map((m): [number, string] => [Number(m[2]), m[1]]);
		return [...new Map(found.map((t) => [t.join(":"), t])).values()].sort(
			(a, b) => a[0] - b[0]
		);
	}

	/** Just the indices, for the cases that only care about position. */
	function indices(name: string): number[] {
		return [...new Set(targets(name).map(([i]) => i))].sort((a, b) => a - b);
	}

	/**
	 * The 1-based positions of the paths whose `d` starts with each prefix, in
	 * the order the prefixes are given. The rule says "the lid bar and its
	 * handle"; the prefix is that sentence written as the data lucide draws,
	 * so a redraw fails here instead of animating a neighbouring path.
	 */
	function positionsOf(Icon: LucideIcon, name: string, prefixes: string[]): number[] {
		const kids = children(Icon);
		return prefixes
			.map((prefix) => {
				const at = kids.findIndex((c) => c.d.startsWith(prefix));
				expect(at, `lucide no longer draws ${name}'s \`${prefix}…\` path`).toBeGreaterThan(
					-1
				);
				return at + 1;
			})
			.sort((a, b) => a - b);
	}

	/**
	 * Every motion that addresses children, and what those children *are*.
	 * Stated as path data rather than as a position, because the position is
	 * the thing under test.
	 */
	const CHILD_MOTIONS: [name: string, prefixes: string[]][] = [
		// The lid bar and the handle that sits on it - not the two tines or
		// the can body, which stay put.
		[ICON_MOTION.lid, ["M3 6h18", "M8 6V4"]],
		// The hands polyline. Child 1 is a `circle`, the dial, which is also
		// why the "addresses paths" case below cannot assume every child is a
		// path the way it used to.
		[ICON_MOTION.hands, ["M12 6v6l4 2"]],
		// The four arcs, right-inner, right-outer, left-outer, left-inner. The
		// centre dot is a `circle` and does not move.
		[ICON_MOTION.waves, ["M16.247", "M19.075", "M4.925", "M7.753"]],
		// Both braces: the motion is the gap between them.
		[ICON_MOTION.spread, ["M8 3H7", "M16 21h1"]],
		// The arrow's shaft and head. The tray is what it drops into.
		[ICON_MOTION.drop, ["M12 15V3", "m7 10 5 5 5-5"]],
		// The same two for Upload - drawn in a different order, which is the
		// whole reason these are pinned rather than assumed symmetric.
		[ICON_MOTION.lift, ["M12 3v12", "m17 8-5-5-5 5"]],
		// Both chevrons of `CodeXml`; child 3 is the slash between them and
		// stays. Right-then-left, which is the whole reason this is not
		// `spread` - see the rule's comment.
		[ICON_MOTION.part, ["m18 16 4-4-4-4", "m6 8-4 4 4 4"]],
		// The needle, not the dial arc.
		[ICON_MOTION.sweep, ["m12 14 4-4"]],
		// The trace itself, Activity's only child.
		[ICON_MOTION.trace, ["M22 12h-2.48"]],
	];

	it.each(CHILD_MOTIONS)("%s names the right children of its glyph", (name, prefixes) => {
		const Icon = MOTION_GLYPH[name];
		expect(Icon, `${name} has no glyph in MOTION_GLYPH`).toBeDefined();
		expect(indices(name)).toEqual(positionsOf(Icon, name, prefixes));
	});

	/**
	 * The motions whose children are not `path`s, pinned by where the shape
	 * sits rather than by its path data. Each entry is the `x,y` of a `rect`'s
	 * corner or the `cx,cy` of an `ellipse`'s centre, in the order the rule
	 * names them - which is what fixes each tile's direction and which disc
	 * lifts.
	 */
	const SHAPE_MOTIONS: [name: string, at: string[]][] = [
		// Top-left, top-right, bottom-right, bottom-left: the corner each tile
		// sits in is its direction, so a reordering upstream would send one
		// tile the wrong way while the glyph still looked right at rest.
		[ICON_MOTION.tiles, ["3,3", "14,3", "14,12", "3,16"]],
		// Bottom-right, bottom-left, top. The top node is child 3, which is
		// the one that pulses first.
		[ICON_MOTION.pulse, ["16,16", "2,16", "9,2"]],
		// The top disc.
		[ICON_MOTION.stack, ["12,5"]],
	];

	it.each(SHAPE_MOTIONS)("%s names the right shapes of its glyph", (name, at) => {
		const kids = children(MOTION_GLYPH[name]);
		const named = targets(name).map(([index]) => kids[index - 1]?.at);
		expect(named).toEqual(at);
	});

	it("addresses the element type it names, at every index it names", () => {
		// `nth-child` counts every child whatever its tag, so a rule written
		// `> path:nth-child(2)` against a glyph whose second child is a
		// `circle` matches nothing at all - which renders, and looks like a
		// motion someone simply chose not to give that icon. Clock and Radio
		// draw a `circle`, LayoutDashboard and Network draw `rect`s and
		// Database an `ellipse`, so this is a live failure mode here rather
		// than a hypothetical one.
		let checked = 0;
		for (const name of Object.values(ICON_MOTION)) {
			const named = targets(name);
			if (named.length === 0) continue;
			const kids = children(MOTION_GLYPH[name]);
			for (const [index, tag] of named) {
				expect(
					kids[index - 1],
					`${name} names a child ${index} that does not exist`
				).toBeDefined();
				expect(
					kids[index - 1]?.tag,
					`${name} addresses <${tag}>:nth-child(${index}), which is a <${kids[index - 1]?.tag}>`
				).toBe(tag);
				checked++;
			}
		}
		expect(checked, "no child was checked, so this proves nothing").toBeGreaterThan(20);
	});

	it("uses one `part` rule for both code glyphs, which lucide draws alike", () => {
		// `part` is spelled by Code2 (lucide's `CodeXml`) and by `Code`, and
		// one rule moves child 1 right and child 2 left. That only holds while
		// both glyphs are drawn right-chevron first; the day one is flipped
		// upstream, that glyph's brackets close instead of parting, and the
		// diff that did it is a version bump.
		for (const [icon, Glyph] of [
			["CodeXml", CodeXml],
			["Code", Code],
		] as const) {
			const [right, left] = children(Glyph);
			expect(right.d, `${icon}'s first child is no longer the right chevron`).toMatch(
				/^m1[68] /
			);
			expect(left.d, `${icon}'s second child is no longer the left chevron`).toMatch(
				/^m[68] /
			);
		}
	});

	it("measures the draw-in rather than trusting the number in the comment", () => {
		// `trace`'s dash has to be at least the path's own length or the glyph
		// finishes with a second dash creeping in behind the first. jsdom has
		// no `getTotalLength`, so what is pinned here is the input that number
		// was measured from: the exact path lucide draws. A redraw fails here,
		// which is the moment someone has to re-measure in a browser - the
		// value and how it was taken are in the rule's comment.
		const [trace] = children(Activity);
		expect(trace.d).toBe(
			"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
		);
		// 49.214 units measured in Chromium, rounded up to 50.
		const dash = /@keyframes icon-trace \{[^}]*?stroke-dasharray:\s*(\d+)/s.exec(code);
		expect(dash, "icon-trace no longer sets a dasharray").not.toBeNull();
		expect(Number(dash?.[1])).toBeGreaterThanOrEqual(50);
	});

	it("moves the whole svg wherever it names no child", () => {
		// Every whole-glyph motion must not have grown a child selector
		// without gaining the per-child origin reasoning the lid rule carries.
		const childMotions = new Set([
			...CHILD_MOTIONS.map(([name]) => name),
			...SHAPE_MOTIONS.map(([name]) => name),
		]);
		const wholeGlyph = Object.values(ICON_MOTION).filter((n) => !childMotions.has(n));
		expect(wholeGlyph.length).toBeGreaterThan(5);
		for (const name of wholeGlyph) {
			expect(indices(name), `${name} now addresses a child`).toEqual([]);
		}
	});

	it("gives every motion a glyph, so a new name cannot skip these checks", () => {
		for (const name of Object.values(ICON_MOTION)) {
			expect(MOTION_GLYPH[name], `${name} names no glyph in MOTION_GLYPH`).toBeDefined();
		}
	});
});

describe("icon motion: the frame the ink is allowed to leave", () => {
	/** The declarations of the bare `[data-icon-motion="<name>"]` rules. */
	function rootBody(name: string): string {
		return rules
			.filter((r) => r.selectors.includes(`[data-icon-motion="${name}"]`))
			.map((r) => r.body)
			.join("");
	}

	it.each(FRAME_LEAVING)("%s lets its ink paint past the viewBox", (name) => {
		expect(rootBody(name), `${name} leaves the frame and would be clipped`).toContain(
			"overflow: visible"
		);
	});

	it("declares overflow on the frame-leaving motions and nowhere else", () => {
		// The other direction: `overflow: visible` on a motion that stays
		// inside is a declaration nobody can tell is dead, and it is how the
		// list above stops meaning anything.
		const leaving = new Set<string>(FRAME_LEAVING);
		const declared = [...code.matchAll(/\[data-icon-motion="([a-z-]+)"\]\s*\{([^}]*)\}/g)]
			.filter((m) => m[2].includes("overflow: visible"))
			.map((m) => m[1]);
		expect(declared.length, "nothing declares overflow, so the scan is vacuous").toBe(
			FRAME_LEAVING.length
		);
		expect([...declared].sort()).toEqual([...leaving].sort());
	});
});
