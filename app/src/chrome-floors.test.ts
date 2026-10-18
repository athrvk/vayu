/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Chrome bands, interactive targets and icons hold their own floors, and
 * density must not carry them below it (issue #1679). `--spacing` scales
 * rhythm - row heights, paddings, gaps - and these three classes of thing are
 * exactly the ones that do not ride it: see the "Chrome, Target and Icon
 * Floors" table in docs/design-system.md and the ten steps `density.test.ts`
 * checks against `index.css`.
 *
 * This is a source scan, not a render: vitest stubs CSS imports to `""`, and
 * jsdom does no layout, so the only way to see a class string is to read the
 * file off disk.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = here;

function read(relPath: string): string {
	return readFileSync(join(srcRoot, relPath), "utf8");
}

/** The opening tag's text: up to the first `>` outside quotes and braces. */
function openingTag(code: string, start: number): string {
	let depth = 0;
	let quote = "";
	for (let i = start; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") depth--;
		else if (c === ">" && depth === 0) return code.slice(start, i);
	}
	return code.slice(start);
}

function files(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !f.includes(".test."))
		.map((f) => join(srcRoot, f));
}

describe("chrome bands carry their own floor, not a list-row height", () => {
	const cases: [label: string, path: string, needle: RegExp][] = [
		// TabStrip and DrawerPanel both read --tabstrip-height, which
		// titlebar-height.test.ts holds to `var(--spacing-band)` directly -
		// checked here as the class reference that carries it.
		["TabStrip", "components/layout/TabStrip.tsx", /h-\[var\(--tabstrip-height\)\]/],
		["DrawerPanel", "components/shared/DrawerPanel.tsx", /h-\[var\(--tabstrip-height\)\]/],
		[
			"the response toolbar",
			"components/shared/response-viewer/ResponseBody.tsx",
			/\bh-band\b/,
		],
		["UpdateBanner", "components/shared/UpdateBanner.tsx", /\bh-banner\b/],
		// `min-h-banner`, not `h-banner`: this banner's text genuinely wraps
		// (see RecoveryBanner.tsx's own comment), so it states a floor rather
		// than a fixed height.
		["RecoveryBanner", "components/shared/RecoveryBanner.tsx", /\bmin-h-banner\b/],
		["RailButton", "components/layout/RailButton.tsx", /\bh-band\b/],
	];

	it.each(cases)("%s carries a band-or-banner floor class", (_label, path, needle) => {
		const source = read(path);
		expect(source.length).toBeGreaterThan(300);
		expect(stripComments(source)).toMatch(needle);
	});
});

describe("interactive targets clear the 24x24px floor, not a bare rhythm class", () => {
	// Each entry names the specific interactive element this issue moved to
	// the `target`/`h-target` floor, and how many times that floor class
	// must appear in the *code* (comments stripped first - see
	// stripComments's own doc comment for why that matters here). A plain
	// "appears somewhere" check passes on a half-fixed file: RunItem has two
	// separate buttons (pin, delete) that both need `size-target`, and
	// checking only "at least one" stays green if just one of the two is
	// reverted. Scoped to the elements the issue actually names, not a
	// blanket "no h-5/h-6/h-7/size-6/size-7 anywhere in the file" scan - both
	// KeyValueRow's kind-toggle button and RunItem's `h-5` identity row use
	// those classes for reasons unrelated to this issue's floor (a bare
	// layout row and a button outside the acceptance criteria's list), so a
	// file-wide scan would fail on code this issue was never meant to touch.
	// Mutation check (confirmed live): put `h-6 w-6` back on RunItem's pin
	// button alone, red. The banner closes are not in this list - they carry
	// no floor class of their own (they rely on `Button`'s `size="icon"`
	// default, `size-target`), so their regression guard is the negative
	// check in the describe block below instead.
	const cases: [label: string, path: string, floor: RegExp, count: number][] = [
		["Switch root", "components/ui/switch.tsx", /\bh-target\b/, 1],
		["Toast action", "components/ui/toast.tsx", /\bh-control-sm\b/, 1],
		["Toast close", "components/ui/toast.tsx", /\bsize-target\b/, 1],
		["Dialog close", "components/ui/dialog.tsx", /\bsize-target\b/, 1],
		["RunItem pin/delete buttons", "modules/history/sidebar/RunItem.tsx", /\bsize-target\b/, 2],
		["CommandSearchBar trigger", "components/layout/CommandSearchBar.tsx", /\bh-target\b/, 1],
		[
			// 5: the Checkbox and its same-width placeholder `<div>` (when
			// `allowDisable` is false), the file/text kind toggle, and the
			// Remove button with its placeholder - each holds its column's width.
			"KeyValueRow checkbox",
			"components/shared/KeyValueEditor/KeyValueRow.tsx",
			/\bsize-target\b/,
			5,
		],
	];

	it.each(cases)("%s carries the target floor $count time(s)", (_label, path, floor, count) => {
		const source = read(path);
		expect(source.length).toBeGreaterThan(300);
		const hits = stripComments(source).match(new RegExp(floor, "g")) ?? [];
		expect(hits.length, `${path} does not carry the target floor ${count} time(s)`).toBe(count);
	});
});

describe('interactive elements keep no undersized override on Button\'s size="icon" default', () => {
	// UpdateBanner and RecoveryBanner's close buttons, and (since #1681) the
	// icon buttons below, carry no `size-target` class of their own - they
	// rely on `Button`'s / `TooltipIconButton`'s default `size="icon"`,
	// which resolves to `size-target` (button-variants.ts). That means the
	// positive per-occurrence check above (which reads a floor class off the
	// element) cannot guard them: an independent review found that putting
	// `className="size-7"` back on one leaves this file green, because
	// nothing here ever asserted its *absence*. Mutation check: confirmed
	// live - restoring `size-7` reds this case.
	//
	// The #1681 fix removed same-number `h-N w-N`/`w-N h-N` pairs and bare
	// `size-N` overrides (N 4-7); the check below is scoped to exactly that
	// shape rather than a blanket "no h-N or w-N anywhere in the file" scan,
	// since several of these files also carry legitimately different-sized
	// Select controls that would false-positive on a bare single-axis scan.
	// An `Input`'s height has its own rule, in the last block of this file.
	const cases: [label: string, path: string][] = [
		["UpdateBanner", "components/shared/UpdateBanner.tsx"],
		["RecoveryBanner", "components/shared/RecoveryBanner.tsx"],
		["ResponseActions copy/download", "components/shared/response-viewer/ResponseActions.tsx"],
		["CodeSection reveal/recompose/copy", "components/layout/context-bar/CodeSection.tsx"],
		["ContextBar close", "components/layout/ContextBar.tsx"],
		["TrashItem restore/purge", "modules/trash/sidebar/TrashItem.tsx"],
		[
			"VariablesCategoryTree add environment",
			"modules/variables/sidebar/VariablesCategoryTree.tsx",
		],
		[
			"ExamplesPanel delete",
			"modules/request-builder/components/RequestTabs/panels/ExamplesPanel.tsx",
		],
		[
			"GraphQLBody schema toggle/refresh",
			"modules/request-builder/components/RequestTabs/panels/body/GraphQLBody.tsx",
		],
		["CollectionTree add collection/request/import", "modules/collections/CollectionTree.tsx"],
	];
	const UNDERSIZED_OVERRIDE = /\bh-([4-7])\s+w-\1\b|\bw-([4-7])\s+h-\2\b|\bsize-[4-7]\b/;

	it.each(cases)("%s carries no undersized size/h-w-pair override", (_label, path) => {
		const source = stripComments(read(path));
		expect(source.length).toBeGreaterThan(300);
		expect(source).not.toMatch(UNDERSIZED_OVERRIDE);
	});
});

describe("icons use the size-icon / size-icon-sm step, not a --spacing multiple", () => {
	// Beyond the acceptance criteria's own `size-4|w-4 h-4|h-4 w-4|w-3 h-3`,
	// this also covers the two forms an independent review found the
	// original codemod's narrower pattern missed: `h-3 w-3` (the reverse
	// axis order, MethodSelector.tsx used `[&>svg]:h-3 [&>svg]:w-3`) and a
	// per-icon `[&_svg]:size-3`/`[&_svg]:size-4` override, which reaches the
	// same 9px/12px result through an arbitrary variant rather than a bare
	// class and so read past a plain-class-only pattern.
	const OFFENDER =
		/\b(?:size-4|w-4 h-4|h-4 w-4|w-3 h-3|h-3 w-3)\b|\[&[_>]svg\]:(?:size-[34]|[hw]-[34])\b/;

	function guardedFiles(): string[] {
		return globSync("**/*.{ts,tsx}", { cwd: srcRoot })
			.filter((f) => !f.includes(".test."))
			.map((f) => join(srcRoot, f));
	}

	it("scans a non-empty set of files", () => {
		expect(guardedFiles().length).toBeGreaterThan(200);
	});

	it("finds no size-4 / w-4 h-4 / h-4 w-4 / w-3 h-3 (either axis order, bare or [&_svg]) outside test files", () => {
		const offences: string[] = [];

		for (const file of guardedFiles()) {
			const source = readFileSync(file, "utf8");
			const code = stripComments(source).split(/\r?\n/);
			source.split(/\r?\n/).forEach((line, i) => {
				const hit = code[i].match(OFFENDER);
				if (hit) {
					offences.push(
						`${relative(srcRoot, file)}:${i + 1}  ${hit[0]}\n    ${line.trim()}`
					);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});

describe("no interactive element anywhere carries a sub-24px box override", () => {
	// The enumerated list above guards files someone remembered; this one scans
	// every non-test file, because a `className="h-7 w-7"` on an icon Button
	// outranks `size-target` in emission order and nothing else notices (the
	// gap #1679 was reopened for). A plain `<button>` and `TimeMarker` (which
	// forwards `className` to its Button) are in scope too: a hand-rolled
	// trigger is where the floor slipped before. So is `SelectTrigger`, whose
	// own base is `h-control` (28px): an `h-7` on it is 21px at Default. So is
	// `DialogCancelButton`, a `Button` under another name: an `h-7` on one sat
	// 3px short of the `Input` and Add button beside it (#1830). At the 3px unit h-N / w-N /
	// size-N is 3N px, so N <= 7.5 is under 24px, fractions included; an
	// arbitrary `h-[18px]` / `size-[1rem]` is checked against 24px with a 16px
	// rem. Use `h-control-sm` / `size-target` instead.
	//
	// The second bound is a bare `h-8` or `h-9`, on height only (#1912, #2304).
	// `h-8` is 24px, so it clears the floor, but it is the pre-density literal
	// #1679 retired from controls: a control states `h-control` /
	// `h-control-sm`, which are the same 24px at Default and 32px at Comfortable.
	// `h-9` is the 27px `Button` default #1679 replaced, and a `SelectTrigger`
	// carrying it sits proud of the `h-control` Input beside it. `w-8` and
	// `size-8` stay legitimate boxes. The drawer row's `h-8` is normally a
	// `<div>`, outside the tag set; the hand-rolled `<button>` rows are counted
	// in DRAWER_ROW_BUTTONS.
	//
	// The third rule is shape, not a number: a plain `<button>` whose only
	// content is a glyph is as wide as the glyph (12px or 16px) unless its own
	// className states a box (#2304). The scan reads the tag's className and its
	// children; a box that arrives in a variable is invisible to it, so state the
	// class inline.
	const OPEN =
		/<(?:Button|button|TooltipIconButton|TimeMarker|SelectTrigger|DialogCancelButton)\b/g;
	// The lookbehind keeps `min-w-0` and `max-h-6` out (a floor or a cap, not
	// the box) while still catching a variant-prefixed `sm:w-5` or
	// `[&_svg]:size-3`. Bare `0` is not matched: `w-0` hides a box rather than
	// shrinking a target.
	const BOX_SIZE =
		/(?<![\w-])(?:h|w|size)-(?:(0\.\d+|[1-7](?:\.\d+)?)(?![\w./])|\[(\d+(?:\.\d+)?)(px|rem)\])/g;
	// A height of exactly 8 or 9 (not `h-80`, `h-8.5`, `min-h-8` or `h-8/12`).
	const RETIRED_HEIGHT = /(?<![\w-])h-(?:8|9)(?![\w./-])/;
	const DRAWER_ROW_HEIGHT = "h-8";
	// The icon steps are glyph sizes, not target sizes (12px / 16px). On the tag
	// itself, unprefixed, one is the element's box - and on a `Button` it also
	// replaces the `size-target` variant (tailwind-merge). A `[&_svg]:size-icon`
	// sizes a descendant and is left alone, so the lookbehind refuses any
	// variant prefix. A pseudo-element that states the floor (`after:size-target`,
	// the TabItem close button's shape) keeps the glyph and grows the hit area.
	const BARE_ICON_BOX = /(?<![\w:\]-])size-icon(?:-sm)?(?![\w-])/;
	const PSEUDO_TARGET_FLOOR = /(?<![\w-])(?:after|before):size-target(?![\w-])/;
	const TARGET_FLOOR_PX = 24;
	const PX_PER_REM = 16;

	/** The first class in `tag` that sizes a box under the 24px target floor. */
	function undersizedClass(tag: string): string | undefined {
		for (const m of tag.matchAll(BOX_SIZE)) {
			if (m[1] !== undefined) return m[0];
			const px = Number(m[2]) * (m[3] === "rem" ? PX_PER_REM : 1);
			if (px < TARGET_FLOOR_PX) return m[0];
		}
		return undefined;
	}

	/**
	 * The value of `tag`'s own `className` attribute. A glyph passed as a prop
	 * (`icon={<X className="size-icon-sm" />}`) sits inside braces, at depth 1,
	 * and is not the element's box.
	 */
	function ownClassName(tag: string): string {
		let depth = 0;
		for (let i = 0; i < tag.length; i++) {
			if (tag[i] === "{") depth++;
			else if (tag[i] === "}") depth--;
			else if (depth === 0 && tag.startsWith("className=", i)) {
				return attributeValue(tag, i + "className=".length);
			}
		}
		return "";
	}

	/** The quoted string or balanced `{...}` expression starting at `start`. */
	function attributeValue(tag: string, start: number): string {
		const open = tag[start];
		if (open === '"' || open === "'") {
			return tag.slice(start, tag.indexOf(open, start + 1) + 1);
		}
		let depth = 0;
		for (let i = start; i < tag.length; i++) {
			if (tag[i] === "{") depth++;
			else if (tag[i] === "}" && --depth === 0) return tag.slice(start, i + 1);
		}
		return tag.slice(start);
	}

	/** A bare icon-step box on `tag` with no pseudo-element hit area behind it. */
	function iconBoxWithoutFloor(tag: string): string | undefined {
		const classes = ownClassName(tag);
		if (PSEUDO_TARGET_FLOOR.test(classes)) return undefined;
		return classes.match(BARE_ICON_BOX)?.[0];
	}

	function retiredHeight(tag: string): string | undefined {
		return tag.match(RETIRED_HEIGHT)?.[0];
	}

	// A box needs both axes. `size-target` and a pseudo-element hit area state
	// both; otherwise one class from each list. `self-stretch` is a height only
	// by the row's grace, so it does not count.
	const SQUARE_BOX = /(?<![\w:-])(?:size-target|size-full)(?![\w-])/;
	const HEIGHT_BOX =
		/(?<![\w:-])(?:h-target|min-h-target|h-full|h-control(?:-[a-z]+)?|h-band(?:-[a-z]+)?)(?![\w-])/;
	const WIDTH_BOX = /(?<![\w:-])(?:w-target|min-w-target|w-full)(?![\w-])/;

	/** Whether `tag`'s own className states a box at least 24px on both axes. */
	function statesTargetBox(tag: string): boolean {
		const classes = ownClassName(tag);
		if (SQUARE_BOX.test(classes) || PSEUDO_TARGET_FLOOR.test(classes)) return true;
		return HEIGHT_BOX.test(classes) && WIDTH_BOX.test(classes);
	}

	/**
	 * Whether `body` (a button's children) is a glyph and nothing else: a glyph
	 * is a self-closing tag of a name the file imports from lucide-react, and an
	 * `sr-only` span or a `{...}` that only chooses between glyphs does not make
	 * it a labelled button.
	 */
	function isGlyphOnly(body: string, glyphNames: ReadonlySet<string>): boolean {
		let rest = body.replace(/<span className="sr-only">[^<]*<\/span>/g, "");
		let glyphs = 0;
		for (let m = /<[A-Z]\w*\b/.exec(rest); m; m = /<[A-Z]\w*\b/.exec(rest)) {
			const tag = openingTag(rest, m.index);
			if (!tag.endsWith("/") || !glyphNames.has(m[0].slice(1))) return false;
			rest = `${rest.slice(0, m.index)}GLYPH${rest.slice(m.index + tag.length + 1)}`;
			glyphs++;
		}
		rest = rest.replace(/\{[^{}]*GLYPH[^{}]*\}/g, "GLYPH").replace(/GLYPH|\s/g, "");
		return glyphs > 0 && rest === "";
	}

	/** Whether `tag`, a plain `<button>` opening at `start` in `code`, holds only a glyph. */
	function holdsOnlyGlyph(code: string, start: number, tag: string): boolean {
		if (tag.endsWith("/")) return false;
		const bodyStart = start + tag.length + 1;
		const bodyEnd = code.indexOf("</button>", bodyStart);
		return bodyEnd !== -1 && isGlyphOnly(code.slice(bodyStart, bodyEnd), lucideNames(code));
	}

	/** The local names `code` imports from lucide-react, an `as` alias taking the alias. */
	function lucideNames(code: string): Set<string> {
		const names = new Set<string>();
		for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
			for (const spec of m[1].split(",")) {
				const local = spec
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)
					.pop();
				if (local) names.add(local);
			}
		}
		return names;
	}

	/** A finding for a plain `<button>` at `start` that holds only a glyph and states no box. */
	function boxlessGlyphButton(code: string, start: number, tag: string): string | undefined {
		if (!code.startsWith("<button", start) || !holdsOnlyGlyph(code, start, tag))
			return undefined;
		return statesTargetBox(tag) ? undefined : "glyph-only button without a stated 24px box";
	}

	/** The first class in `tag` that sizes a control with a bound this scan rejects. */
	function offendingClass(tag: string): string | undefined {
		return undersizedClass(tag) ?? iconBoxWithoutFloor(tag) ?? retiredHeight(tag);
	}

	// A hand-rolled `<button>` that IS a single-line drawer row keeps `h-8`: the
	// row height is the drawer's own (docs/design-system.md, "Drawer Row
	// Metric"), not a control's. The others of its kind are `<div>`s and never
	// reach this scan. Keyed by path under `src/`, with the exact number of tags
	// allowed: a further `h-8` in the same file is an offence, and the rot test
	// below fails when the file stops carrying exactly that many, so an entry
	// cannot outlive its row.
	const DRAWER_ROW_BUTTONS: Record<string, { tags: number; reason: string }> = {
		"modules/settings/sidebar/SettingsCategoryTree.tsx": {
			tags: 1,
			reason: "a category row of the Settings drawer, beside the other single-line drawer rows",
		},
	};

	/** One line per interactive tag in `code` that breaks a bound, exemptions spent first-come. */
	function offencesIn(
		path: string,
		code: string,
		exemptions: typeof DRAWER_ROW_BUTTONS
	): string[] {
		let allowance = exemptions[path]?.tags ?? 0;
		const offences: string[] = [];
		for (const m of code.matchAll(OPEN)) {
			const tag = openingTag(code, m.index);
			const retired = retiredHeight(tag);
			const spendsAllowance = retired === DRAWER_ROW_HEIGHT && allowance-- > 0;
			const hit =
				undersizedClass(tag) ??
				iconBoxWithoutFloor(tag) ??
				(spendsAllowance ? undefined : retired) ??
				boxlessGlyphButton(code, m.index, tag);
			if (hit) offences.push(`${path}: ${m[0]} ${hit}`);
		}
		return offences;
	}

	function sourcePath(file: string): string {
		return relative(srcRoot, file).split(sep).join("/");
	}

	/** How many interactive tags in `file` carry a bare `h-8`. */
	function drawerRowHeightTags(file: string): number {
		const code = stripComments(readFileSync(file, "utf8"));
		return [...code.matchAll(OPEN)].filter(
			(m) => retiredHeight(openingTag(code, m.index)) === DRAWER_ROW_HEIGHT
		).length;
	}

	/** How many plain `<button>`s across the tree hold nothing but a glyph. */
	function glyphOnlyButtonCount(): number {
		return files().reduce((total, file) => {
			const code = stripComments(readFileSync(file, "utf8"));
			const buttons = [...code.matchAll(/<button\b/g)].filter((m) =>
				holdsOnlyGlyph(code, m.index, openingTag(code, m.index))
			);
			return total + buttons.length;
		}, 0);
	}

	it.each([
		["a whole step", "h-7", "h-7"],
		["a fractional step", "h-3.5 rounded-md", "h-3.5"],
		["a sub-1 step", "size-0.5", "size-0.5"],
		["the top fractional step", "w-7.5", "w-7.5"],
		["a variant-prefixed class", "sm:w-5", "w-5"],
		["an arbitrary px size", "h-[18px]", "h-[18px]"],
		["an arbitrary rem size", "size-[1rem]", "size-[1rem]"],
		["an svg descendant override", "[&_svg]:size-3", "size-3"],
		["a bare h-8", "h-8 w-auto", "h-8"],
		["a bare h-9", "h-9 text-sm", "h-9"],
		["a bare size-icon-sm box", "size-icon-sm rounded-full", "size-icon-sm"],
		["a bare size-icon box", "flex size-icon", "size-icon"],
		["a variant-prefixed h-8", "sm:h-8 px-3", "h-8"],
	])("flags %s", (_label, classes, expected) => {
		expect(offendingClass(`<Button className="${classes}"`)).toBe(expected);
	});

	it.each([
		["the target floor class", "size-target"],
		["a width and size at the floor", "w-8 size-8"],
		["a step above the floor", "h-10 size-12"],
		["an arbitrary size at the floor", "h-[24px] w-[1.5rem]"],
		["an arbitrary size above the floor", "h-[2rem]"],
		["a variable-backed size", "h-[var(--spacing-target)]"],
		["a zero minimum", "min-w-0"],
		["a max cap", "max-h-6"],
		["a fraction of the parent", "w-1/2"],
		["a glyph size on a descendant", "[&_svg]:size-icon-sm [&>svg]:size-icon"],
		["an icon step beside a pseudo-element target", "size-icon-sm after:size-target"],
		["a container-size width", "w-3xs"],
		["a min-height at the retired step", "min-h-8"],
		["a max-height at the retired step", "max-h-8"],
		["a taller step", "h-80 h-8.5 h-90 h-9.5 min-h-9"],
		["a control token", "h-control-sm"],
	])("does not flag %s", (_label, classes) => {
		expect(offendingClass(`<Button className="${classes}"`)).toBeUndefined();
	});

	it("reads the icon step off the tag's own className, not a glyph passed as a prop", () => {
		const glyphProp =
			'<TooltipIconButton icon={<X className="size-icon-sm" />} className="flex" />';
		const ownBox =
			'<button className={cn("size-icon", extra)} icon={<X className="size-icon" />}>';
		const quoted = "<button className='size-icon-sm'>";
		expect(offencesIn("a.tsx", glyphProp, {})).toEqual([]);
		expect(offencesIn("a.tsx", ownBox, {})).toEqual(["a.tsx: <button size-icon"]);
		expect(offencesIn("a.tsx", quoted, {})).toEqual(["a.tsx: <button size-icon-sm"]);
	});

	const LUCIDE_IMPORT = 'import { X, ChevronDown, ChevronRight } from "lucide-react";\n';
	const glyphButton = (classes: string, children = "<X />") =>
		`${LUCIDE_IMPORT}<button type="button" className="${classes}" onClick={go}>${children}</button>`;

	it.each([
		["no className at all", `${LUCIDE_IMPORT}<button onClick={go}><X /></button>`],
		["a colour only", glyphButton("p-1 text-muted-foreground")],
		[
			"a colour and a margin",
			glyphButton("ml-auto text-muted-foreground hover:text-foreground"),
		],
		["a height with no width", glyphButton("h-target")],
		["a width with no height", glyphButton("min-w-target")],
		["a self-stretch height and a width", glyphButton("self-stretch min-w-target")],
		["a prefixed floor that is not the element's own box", glyphButton("sm:size-target")],
		[
			"a glyph with an sr-only label",
			glyphButton("p-1", '<X /><span className="sr-only">Close</span>'),
		],
		[
			"a ternary between two glyphs",
			glyphButton("self-stretch", "{open ? (<ChevronDown />) : (<ChevronRight />)}"),
		],
		[
			"a glyph whose props hold a size box",
			glyphButton("flex", '<X className="size-target" />'),
		],
	])("flags a glyph-only button with %s", (_label, source) => {
		expect(offencesIn("a.tsx", source, {})).toEqual([
			"a.tsx: <button glyph-only button without a stated 24px box",
		]);
	});

	it.each([
		["a square target box", glyphButton("size-target rounded-md")],
		["a height and a width token", glyphButton("h-target min-w-target")],
		["a control height and a full width", glyphButton("h-control w-full")],
		["a band height and a target width", glyphButton("h-band-lg w-target")],
		["a stretched height stated as a minimum", glyphButton("min-h-target min-w-target -ml-2")],
		[
			"a glyph with a pseudo-element hit area",
			glyphButton("relative size-icon-sm after:size-target"),
		],
		[
			"a box in an expression",
			`${LUCIDE_IMPORT}<button className={cn("size-target", extra)}><X /></button>`,
		],
		[
			"a self-closing component that is not a lucide glyph",
			glyphButton("flex", "<TimeValue />"),
		],
		["a label beside the glyph", glyphButton("flex gap-1", "<X />Dismiss")],
		["a wrapping element around the glyph", glyphButton("flex", "<span><X /></span>")],
		["a non-self-closing capitalised child", glyphButton("flex", "<Tooltip><X /></Tooltip>")],
		["no glyph at all", glyphButton("flex", "Close")],
		["a self-closing button", `${LUCIDE_IMPORT}<button className="flex" />`],
	])("does not flag a glyph-only button rule on %s", (_label, source) => {
		expect(offencesIn("a.tsx", source, {})).toEqual([]);
	});

	it("flags a retired h-9 and keeps the drawer-row exemption to h-8 alone", () => {
		const exemptions = { "a.tsx": { tags: 1, reason: "test" } };
		expect(offencesIn("a.tsx", '<SelectTrigger className="h-9 text-sm">', exemptions)).toEqual([
			"a.tsx: <SelectTrigger h-9",
		]);
	});

	it("scans a non-empty set of files and tags", () => {
		expect(files().length).toBeGreaterThan(200);
		const tags = files().flatMap((f) =>
			[...stripComments(readFileSync(f, "utf8")).matchAll(OPEN)].map((m) => m[0])
		);
		expect(tags.length).toBeGreaterThan(100);
		expect(tags).toContain("<button");
		expect(tags).toContain("<TimeMarker");
		expect(tags).toContain("<SelectTrigger");
		expect(tags).toContain("<DialogCancelButton");
	});

	it("scans a non-empty set of glyph-only buttons", () => {
		expect(glyphOnlyButtonCount()).toBeGreaterThan(5);
	});

	it("finds no undersized h / w / size, bare h-8 or h-9, or boxless glyph-only button in an interactive element's own tag", () => {
		const offences = files().flatMap((file) =>
			offencesIn(
				sourcePath(file),
				stripComments(readFileSync(file, "utf8")),
				DRAWER_ROW_BUTTONS
			)
		);
		expect(offences.join("\n")).toBe("");
	});

	it("spends an exemption on its allowed count and flags a further h-8 in the same file", () => {
		const row = '<button className="h-8 flex">';
		const exemptions = { "a.tsx": { tags: 1, reason: "test" } };
		expect(offencesIn("a.tsx", row, exemptions)).toEqual([]);
		expect(offencesIn("a.tsx", `${row}${row}`, exemptions)).toEqual(["a.tsx: <button h-8"]);
		expect(offencesIn("b.tsx", row, exemptions)).toEqual(["b.tsx: <button h-8"]);
	});

	it("keeps every drawer-row exemption pointing at exactly its h-8 control tags", () => {
		const entries = Object.entries(DRAWER_ROW_BUTTONS);
		expect(entries.length).toBeGreaterThan(0);
		for (const [path, { tags }] of entries) {
			expect(drawerRowHeightTags(join(srcRoot, path)), `${path} h-8 tag count`).toBe(tags);
		}
	});
});

describe("a text field states its size, never its height", () => {
	// `Input`, `VariableInput` and `SecretInput` take `size="sm" | "xs"` (the
	// `control-sm` and `control-xs` tokens, `input-size.ts`) or nothing
	// (`control`), and that is the whole vocabulary: an `h-6` is a third height
	// the row never agreed to, and `h-full` makes the field's height whatever
	// its row happens to be (#1830). So none of these tags carries a height
	// class of any kind in its className - a step, a fraction, an arbitrary
	// value, `h-full`, a floor token or a `size-*` - and `min-h` / `max-h` stay
	// fine. Whether `size="xs"` is on a field that sits in a `target` row
	// rather than standing alone is a review matter: the scan cannot see the
	// row.
	//
	// UrlInput is the one text field that is a band component, not a control:
	// it fills the min-h-band-md URL bar, so its h-full is correct.
	const FIELDS = ["Input", "VariableInput", "SecretInput"] as const;
	const EXCLUDED = ["UrlInput"] as const;
	const OPEN = new RegExp(`<(?:${FIELDS.join("|")})\\b`, "g");
	const HEIGHT_CLASS = /(?<![\w-])(?:h|size)-[^\s"'`]+/;
	// `xs` is the rename field, and its pull-back and width are drawn for a
	// `gap-2` sibling (`input.tsx`): a padding, margin or width beside it is a
	// second geometry for one field, and the text stops landing on the label.
	const XS_GEOMETRY_CLASS = /(?<![\w-])(?:-?m[lrx]?-|p[lrx]?-|w-)[^\s"'`]+/;

	/** The first class in `tag` that pins a height, of whatever kind. */
	function heightClass(tag: string): string | undefined {
		return tag.match(HEIGHT_CLASS)?.[0];
	}

	/** The first horizontal padding, margin or width class on an `xs` field. */
	function xsOverride(tag: string): string | undefined {
		if (!/\bsize="xs"/.test(tag)) return undefined;
		const className = tag.match(/className=(?:"([^"]*)"|\{[^}]*\})/)?.[0] ?? "";
		return className.match(XS_GEOMETRY_CLASS)?.[0];
	}

	it.each([
		["a whole step", "h-6", "h-6"],
		["a larger whole step", "h-8", "h-8"],
		["a fractional step", "h-7.5", "h-7.5"],
		["an arbitrary height", "h-[26px]", "h-[26px]"],
		["a size- step", "size-7", "size-7"],
		["a fraction of the parent", "h-1/2", "h-1/2"],
		["filling its row", "flex-1 h-full text-sm", "h-full"],
		["the compact control token", "h-control-sm w-24", "h-control-sm"],
		["the default control token", "h-control", "h-control"],
		["the row-field control token", "h-control-xs", "h-control-xs"],
		["a variant-prefixed height", "md:h-6", "h-6"],
	])("flags %s", (_label, classes, expected) => {
		for (const field of FIELDS) {
			expect(heightClass(`<${field} className="${classes}"`)).toBe(expected);
		}
	});

	it.each([
		["a size prop and no height", 'size="xs" className="flex-1 text-sm"'],
		["no height at all", 'className="font-mono text-xs"'],
		["a min-height floor", 'className="min-h-6"'],
		["a max-height cap", 'className="max-h-8"'],
		["a width", 'className="w-24 w-1/2"'],
	])("does not flag %s", (_label, attrs) => {
		expect(heightClass(`<Input ${attrs}`)).toBeUndefined();
	});

	it.each([
		["a padding", 'size="xs" className="flex-1 px-2"', "px-2"],
		["a one-step padding", 'className="px-0.5" size="xs"', "px-0.5"],
		[
			"a pull-back",
			'size="xs" className="-ml-[calc(var(--spacing)*0.5+1px)]"',
			"-ml-[calc(var(--spacing)*0.5+1px)]",
		],
		["a width", 'size="xs" className="w-[calc(100%+4px)] flex-1"', "w-[calc(100%+4px)]"],
		["a left padding", 'size="xs" className="pl-1"', "pl-1"],
	])("flags an xs field carrying %s", (_label, attrs, expected) => {
		expect(xsOverride(`<Input ${attrs}`)).toBe(expected);
	});

	it.each([
		["the size alone", 'size="xs"'],
		["flex and text classes", 'size="xs" className="flex-1 text-sm"'],
		["a shrink floor", 'size="xs" className="min-w-0 flex-1"'],
		["a padding on another size", 'size="sm" className="px-2 w-24"'],
		["a padding with no size", 'className="pl-8 pr-8 text-sm"'],
	])("does not flag %s", (_label, attrs) => {
		expect(xsOverride(`<Input ${attrs}`)).toBeUndefined();
	});

	it("reads past a URL in a string to the end of the tag", () => {
		const code = stripComments(
			'<Input placeholder="https://example.test/spec.json" className="flex-1" /><div className="h-4" />'
		);
		expect(heightClass(openingTag(code, 0))).toBeUndefined();
	});

	it("scans a non-empty set of text-field tags, every kind, and leaves UrlInput out", () => {
		const tags = files().flatMap((f) =>
			[...stripComments(readFileSync(f, "utf8")).matchAll(OPEN)].map((m) => m[0])
		);
		expect(tags.length).toBeGreaterThan(50);
		for (const field of FIELDS) expect(tags).toContain(`<${field}`);
		for (const name of EXCLUDED) expect(tags).not.toContain(`<${name}`);
		// The exclusion is real: the URL bar's field is in the tree, filling its band.
		const urlBar = read("modules/request-builder/components/UrlBar/index.tsx");
		expect(urlBar).toMatch(/<UrlInput\b[^>]*\bh-full\b/);
	});

	it("finds no height class on a text field", () => {
		const offences: string[] = [];
		for (const file of files()) {
			const code = stripComments(readFileSync(file, "utf8"));
			for (const m of code.matchAll(OPEN)) {
				const hit = heightClass(openingTag(code, m.index));
				if (hit) offences.push(`${relative(srcRoot, file)}: ${m[0]} ${hit}`);
			}
		}
		expect(offences.join("\n")).toBe("");
	});

	it('finds no padding, margin or width beside size="xs"', () => {
		const offences: string[] = [];
		let xsFields = 0;
		for (const file of files()) {
			const code = stripComments(readFileSync(file, "utf8"));
			for (const m of code.matchAll(OPEN)) {
				const tag = openingTag(code, m.index);
				if (/\bsize="xs"/.test(tag)) xsFields++;
				const hit = xsOverride(tag);
				if (hit) offences.push(`${relative(srcRoot, file)}: ${m[0]} size="xs" ${hit}`);
			}
		}
		// The four rename fields: collection, request, environment, element.
		expect(xsFields).toBeGreaterThanOrEqual(4);
		expect(offences.join("\n")).toBe("");
	});
});
