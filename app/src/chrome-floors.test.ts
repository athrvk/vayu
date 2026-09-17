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
 * Floors" table in docs/design-system.md and the seven steps `density.test.ts`
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
			"KeyValueRow checkbox",
			"components/shared/KeyValueEditor/KeyValueRow.tsx",
			/\bsize-target accent-primary\b/,
			1,
		],
	];

	it.each(cases)("%s carries the target floor $count time(s)", (_label, path, floor, count) => {
		const source = read(path);
		expect(source.length).toBeGreaterThan(300);
		const hits = stripComments(source).match(new RegExp(floor, "g")) ?? [];
		expect(hits.length, `${path} does not carry the target floor ${count} time(s)`).toBe(count);
	});
});

describe('the banner closes keep no undersized override on Button\'s size="icon" default', () => {
	// UpdateBanner and RecoveryBanner's close buttons carry no `size-target`
	// class of their own - they rely on `Button`'s `size="icon"` variant,
	// which resolves to `size-target` (button-variants.ts). That means the
	// positive per-occurrence check above (which reads a floor class off the
	// element) cannot guard them: an independent review found that putting
	// `className="size-7"` back on one leaves this file green, because
	// nothing here ever asserted its *absence*. Mutation check: confirmed
	// live - restoring `size-7` reds this case.
	const cases: [label: string, path: string][] = [
		["UpdateBanner", "components/shared/UpdateBanner.tsx"],
		["RecoveryBanner", "components/shared/RecoveryBanner.tsx"],
	];
	const UNDERSIZED_OVERRIDE = /\b(?:size-[4-7]|h-[4-7]|w-[4-7])\b/;

	it.each(cases)("%s's close carries no undersized size/h/w override", (_label, path) => {
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
