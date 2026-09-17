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
		expect(source).toMatch(needle);
	});
});

describe("interactive targets clear the 24x24px floor, not a bare rhythm class", () => {
	// Each entry names the specific interactive element this issue moved to
	// the `target`/`h-target` floor. Scoped to the elements the issue
	// actually names, not a blanket "no h-5/h-6/h-7/size-6/size-7 anywhere in
	// the file" scan - both KeyValueRow's kind-toggle button and RunItem's
	// `h-5` identity row use those classes for reasons unrelated to this
	// issue's floor (a bare layout row and a button outside the acceptance
	// criteria's list), so a file-wide scan would fail on code this issue was
	// never meant to touch. Mutation check: put `h-6 w-6` back on RunItem's
	// pin button, red; put `size-7` back on a banner close button (the
	// `chrome bands` describe block above covers the banners themselves).
	const cases: [label: string, path: string, floor: RegExp][] = [
		["Switch root", "components/ui/switch.tsx", /\bh-target\b/],
		["Toast action", "components/ui/toast.tsx", /\bh-control-sm\b/],
		["Toast close", "components/ui/toast.tsx", /\bsize-target\b/],
		["Dialog close", "components/ui/dialog.tsx", /\bsize-target\b/],
		["RunItem pin/delete buttons", "modules/history/sidebar/RunItem.tsx", /\bsize-target\b/],
		["CommandSearchBar trigger", "components/layout/CommandSearchBar.tsx", /\bh-target\b/],
		[
			"KeyValueRow checkbox",
			"components/shared/KeyValueEditor/KeyValueRow.tsx",
			/\bsize-target accent-primary\b/,
		],
	];

	it.each(cases)("%s carries the target floor", (_label, path, floor) => {
		const source = read(path);
		expect(source.length).toBeGreaterThan(300);
		expect(source, `${path} does not carry the target floor`).toMatch(floor);
	});
});

/**
 * Blank out comment bodies, keeping newlines so line numbers still line up -
 * the same approach palette-tokens.test.ts uses, for the same reason: a
 * comment recording what a class used to be (`size-7`, `w-3 h-3`) must not
 * itself trip the guard.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

describe("icons use the size-icon / size-icon-sm step, not a --spacing multiple", () => {
	const OFFENDER = /\b(?:size-4|w-4 h-4|h-4 w-4|w-3 h-3)\b/;

	function guardedFiles(): string[] {
		return globSync("**/*.{ts,tsx}", { cwd: srcRoot })
			.filter((f) => !f.includes(".test."))
			.map((f) => join(srcRoot, f));
	}

	it("scans a non-empty set of files", () => {
		expect(guardedFiles().length).toBeGreaterThan(200);
	});

	it("finds no size-4 / w-4 h-4 / h-4 w-4 / w-3 h-3 outside test files", () => {
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
