/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The space between a `Button`'s icon and its label is the primitive's `gap-2`
 * (`button-variants.ts`), never a margin (#2312).
 *
 * A hand-written `mr-2` on the icon, or `ml-1.5` on the label (a `span` or `LabelSwap`), stacks on
 * top of that gap: the pair sits 14px apart where every other button has 8px,
 * and nothing about the markup says so. The gap is part of the primitive, so a
 * call site that wants a different one writes `gap-*` on the `Button`.
 *
 * Only a Button whose leading children are icons is read. An icon after the
 * label (a trailing chevron) is not covered by this guard. `TooltipIconButton`
 * takes its glyph as the `icon` prop and omits `children`, so it has no label
 * beside the icon to space and nothing to scan.
 *
 * "Leading" includes an icon behind a conditional (`{busy ? <Loader2 /> : <Save />}`,
 * `{busy && <Loader2 />}`): the primitive's gap applies to whichever one
 * renders, and those are the call sites a plain "first element" scan misses.
 *
 * A negative margin (`-ml-1`, an optical nudge) and `ml-auto` / `mr-auto`
 * (layout, not spacing) are not the defect and are not matched.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { lucideNames, openingTagAt, ownClassName } from "@/lib/jsx-opening-tags.testkit";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A fixed-step horizontal margin: `mr-2`, `ml-1.5`, `sm:mr-[6px]`; not `-ml-1` or `ml-auto`. */
const HORIZONTAL_MARGIN = /(?<![\w-])m[lr]-(?:\d|\[)/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
	});
}

/** The end (exclusive) of the balanced `{...}` that opens at `start`. */
function containerEnd(code: string, start: number): number {
	let depth = 0;
	let quote = "";
	for (let i = start; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i + 1;
	}
	return code.length;
}

/** Every self-closing `<Icon … />` in `code` whose name `icons` holds. */
function iconTagsIn(code: string, icons: Set<string>): string[] {
	const found: string[] = [];
	for (const m of code.matchAll(/<([A-Z]\w*)\b/g)) {
		const tag = openingTagAt(code, m.index);
		if (icons.has(m[1]) && tag.endsWith("/")) found.push(tag);
	}
	return found;
}

interface ButtonElement {
	readonly tag: string;
	readonly children: string;
}

/**
 * Every non-self-closing `<Button …>` with the source up to its matching close.
 *
 * Not `elements()` from the testkit: that one finds a tag's end through a
 * file-wide quote mask, and an apostrophe in JSX text ("doesn't") earlier in
 * the file flips the mask, so the tag runs to the end of the file and its
 * children come out empty. `openingTagAt` tracks quotes from the tag's own
 * start, which is the only part of the file this scan needs to read exactly.
 */
function buttonElements(code: string): ButtonElement[] {
	const found: ButtonElement[] = [];
	for (const m of code.matchAll(/<Button\b/g)) {
		const tag = openingTagAt(code, m.index);
		if (tag.endsWith("/")) continue;
		const from = m.index + tag.length + 1;
		found.push({ tag, children: code.slice(from, closeOf(code, from)) });
	}
	return found;
}

/** The offset of the `</Button>` that closes a Button whose children start at `from`. */
function closeOf(code: string, from: number): number {
	let depth = 1;
	for (const m of code.slice(from).matchAll(/<Button\b|<\/Button>/g)) {
		const at = from + m.index;
		if (m[0] === "</Button>") {
			if (--depth === 0) return at;
		} else if (!openingTagAt(code, at).endsWith("/")) depth++;
	}
	return code.length;
}

interface LeadingRun {
	/** The icon tags, in order, that start the button's children. */
	readonly icons: string[];
	/** Everything after them: the label side. */
	readonly rest: string;
}

/**
 * The run of icons (bare or inside a `{...}` expression) a Button's children
 * open with. It ends at the first thing that is not one: text, an element that
 * is not an icon, or an expression holding no icon.
 */
function leadingRun(children: string, icons: Set<string>): LeadingRun {
	const found: string[] = [];
	let rest = children.trimStart();
	for (;;) {
		if (rest.startsWith("{")) {
			const end = containerEnd(rest, 0);
			const container = rest.slice(0, end);
			// A `{/* … */}` note, blanked by `stripComments`, is not the label.
			const empty = container.slice(1, -1).trim() === "";
			const inside = iconTagsIn(container, icons);
			if (inside.length === 0 && !empty) break;
			found.push(...inside);
			rest = rest.slice(end).trimStart();
			continue;
		}
		const name = /^<([A-Z]\w*)\b/.exec(rest)?.[1];
		if (!name || !icons.has(name)) break;
		const tag = openingTagAt(rest, 0);
		if (!tag.endsWith("/")) break;
		found.push(tag);
		rest = rest.slice(tag.length + 1).trimStart();
	}
	return { icons: found, rest };
}

interface Scan {
	/** Buttons whose children open with at least one icon. */
	readonly iconFirstButtons: number;
	/** One line per margin that should be the primitive's gap. */
	readonly offenders: string[];
}

function scanSource(source: string, path: string): Scan {
	const code = stripComments(source);
	const icons = new Set([...lucideNames(code), "IconSwap"]);
	const offenders: string[] = [];
	let iconFirstButtons = 0;

	for (const { tag, children } of buttonElements(code)) {
		const run = leadingRun(children, icons);
		if (run.icons.length === 0) continue;
		iconFirstButtons++;

		for (const icon of run.icons) {
			const className = ownClassName(icon);
			if (HORIZONTAL_MARGIN.test(className)) {
				offenders.push(
					`${path}: icon margin ${className} in ${tag.replace(/\s+/g, " ").slice(0, 70)}`
				);
			}
		}

		const label = /^<(?:span|LabelSwap)\b/.test(run.rest) ? openingTagAt(run.rest, 0) : "";
		if (label && HORIZONTAL_MARGIN.test(ownClassName(label))) {
			offenders.push(
				`${path}: label margin ${ownClassName(label)} in ${tag.replace(/\s+/g, " ").slice(0, 70)}`
			);
		}
	}
	return { iconFirstButtons, offenders };
}

describe("a Button's icon-to-label space is its gap, never a margin", () => {
	const files = walk(srcRoot);
	const scans = files.map((file) => ({
		path: relative(srcRoot, file),
		...scanSource(readFileSync(file, "utf8"), relative(srcRoot, file)),
	}));

	it("scanned a non-empty tree with a real number of icon-first Buttons", () => {
		// A guard that reads nothing, or matches nothing, passes forever.
		expect(files.length).toBeGreaterThan(100);
		const total = scans.reduce((n, s) => n + s.iconFirstButtons, 0);
		expect(total).toBeGreaterThanOrEqual(60);
	});

	it("no icon or label span inside a Button carries a horizontal margin", () => {
		expect(scans.flatMap((s) => s.offenders)).toEqual([]);
	});
});

describe("the scanner", () => {
	const lucide = `import { Save, Loader2, Plus } from "lucide-react";\n`;
	const scan = (jsx: string) => scanSource(lucide + jsx, "fixture.tsx");

	it("flags a margin on a leading icon", () => {
		const { offenders, iconFirstButtons } = scan(
			`<Button onClick={() => go()}><Save className="mr-2 size-icon" />Save</Button>`
		);
		expect(iconFirstButtons).toBe(1);
		expect(offenders).toHaveLength(1);
	});

	it("flags a margin on either icon of a conditional", () => {
		const { offenders } = scan(
			`<Button>{busy ? <Loader2 className="mr-2" /> : <Save className="size-icon ml-1.5" />}Save</Button>`
		);
		expect(offenders).toHaveLength(2);
	});

	it("flags a margin on an icon behind a short-circuit, then another bare icon", () => {
		const { offenders } = scan(
			`<Button>{busy && <Loader2 className="mr-1" />}<Plus className="mr-2" />Add</Button>`
		);
		expect(offenders).toHaveLength(2);
	});

	it("flags a margin on the label span after a leading icon", () => {
		const { offenders } = scan(
			`<Button><Save className="size-icon" /><span className="ml-1.5">Save</span></Button>`
		);
		expect(offenders).toHaveLength(1);
	});

	it("flags a margin on a leading IconSwap and on a LabelSwap label", () => {
		const { offenders } = scan(
			`<Button><IconSwap className="mr-1.5" state="a" icons={{ a: <Save /> }} /><LabelSwap className="ml-1.5" label="x" /></Button>`
		);
		expect(offenders).toHaveLength(2);
	});

	it("leaves a clean button, a trailing icon and a non-leading span alone", () => {
		expect(scan(`<Button><Save className="size-icon" />Save</Button>`).offenders).toEqual([]);
		expect(scan(`<Button>Save<Plus className="ml-2" /></Button>`).offenders).toEqual([]);
		expect(scan(`<Button><span className="ml-2">Save</span></Button>`).offenders).toEqual([]);
		expect(scan(`<Button>{label}<span className="ml-2">x</span></Button>`).offenders).toEqual(
			[]
		);
	});

	it("does not read negative or auto margins, and counts the button either way", () => {
		const { offenders, iconFirstButtons } = scan(
			`<Button><Save className="-ml-1 mr-auto sm:ml-auto" />Save</Button>`
		);
		expect(iconFirstButtons).toBe(1);
		expect(offenders).toEqual([]);
	});

	it("reads a variant-prefixed and an arbitrary-value margin", () => {
		expect(scan(`<Button><Save className="sm:mr-2" />x</Button>`).offenders).toHaveLength(1);
		expect(scan(`<Button><Save className="mr-[6px]" />x</Button>`).offenders).toHaveLength(1);
	});

	it("ignores a margin in a comment", () => {
		const { offenders } = scan(`<Button>{/* mr-2 */}<Save className="size-icon" />x</Button>`);
		expect(offenders).toEqual([]);
	});
});
