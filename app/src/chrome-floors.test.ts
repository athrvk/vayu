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
import { dirname, join, relative } from "node:path";
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
	const OPEN =
		/<(?:Button|button|TooltipIconButton|TimeMarker|SelectTrigger|DialogCancelButton)\b/g;
	// The lookbehind keeps `min-w-0` and `max-h-6` out (a floor or a cap, not
	// the box) while still catching a variant-prefixed `sm:w-5` or
	// `[&_svg]:size-3`. Bare `0` is not matched: `w-0` hides a box rather than
	// shrinking a target.
	const BOX_SIZE =
		/(?<![\w-])(?:h|w|size)-(?:(0\.\d+|[1-7](?:\.\d+)?)(?![\w./])|\[(\d+(?:\.\d+)?)(px|rem)\])/g;
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

	it.each([
		["a whole step", "h-7", "h-7"],
		["a fractional step", "h-3.5 rounded-md", "h-3.5"],
		["a sub-1 step", "size-0.5", "size-0.5"],
		["the top fractional step", "w-7.5", "w-7.5"],
		["a variant-prefixed class", "sm:w-5", "w-5"],
		["an arbitrary px size", "h-[18px]", "h-[18px]"],
		["an arbitrary rem size", "size-[1rem]", "size-[1rem]"],
		["an svg descendant override", "[&_svg]:size-3", "size-3"],
	])("flags %s", (_label, classes, expected) => {
		expect(undersizedClass(`<Button className="${classes}"`)).toBe(expected);
	});

	it.each([
		["the target floor class", "size-target"],
		["a step at the floor", "h-8 w-8"],
		["a step above the floor", "h-10 size-12"],
		["an arbitrary size at the floor", "h-[24px] w-[1.5rem]"],
		["an arbitrary size above the floor", "h-[2rem]"],
		["a variable-backed size", "h-[var(--spacing-target)]"],
		["a zero minimum", "min-w-0"],
		["a max cap", "max-h-6"],
		["a fraction of the parent", "w-1/2"],
		["the size-icon step", "size-icon-sm"],
		["a container-size width", "w-3xs"],
	])("does not flag %s", (_label, classes) => {
		expect(undersizedClass(`<Button className="${classes}"`)).toBeUndefined();
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

	it("finds no undersized h / w / size in an interactive element's own tag", () => {
		const offences: string[] = [];
		for (const file of files()) {
			const code = stripComments(readFileSync(file, "utf8"));
			for (const m of code.matchAll(OPEN)) {
				const hit = undersizedClass(openingTag(code, m.index));
				if (hit) offences.push(`${relative(srcRoot, file)}: ${m[0]} ${hit}`);
			}
		}
		expect(offences.join("\n")).toBe("");
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
