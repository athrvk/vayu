/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Text beside an icon is `cap-centred` (#1830, "Type Scale Conventions" in
 * docs/design-system.md). An `items-center` row centres a label's line box,
 * and Space Grotesk's caps sit 0.57px above that centre at 13px, so every
 * chevron and folder beside them read low; a rename field's text, centred
 * by its own rules, jumped a pixel as the label gave way to it.
 *
 * A source scan, like `chrome-floors.test.ts`: vitest stubs CSS imports to
 * `""` and jsdom does no layout, so the stylesheet is read off disk and the
 * rows are read as source. The classes here are literals at the sites, not
 * values arriving in a variable, so the scan sees what renders.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { indexCss } from "@/lib/css-tokens.testkit";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = dirname(fileURLToPath(import.meta.url));

/** The body of the `.cap-centred` rule, or "" when there is none. */
function capCentredRule(css: string): string {
	return css.match(/\.cap-centred\s*\{([^}]*)\}/)?.[1] ?? "";
}

describe("the cap-centred utility", () => {
	it("trims the box to the cap band and pads it back out to one line", () => {
		expect(indexCss.length).toBeGreaterThan(1000);
		const rule = capCentredRule(stripComments(indexCss));
		// All three or the row moves: the trim alone shrinks a row sized by its
		// text to the cap height, the padding alone pushes the text down, and
		// without the floor the box comes out 1/32px short of its line.
		expect(rule).toMatch(/text-box:\s*trim-both cap alphabetic;/);
		expect(rule).toMatch(/padding-block:\s*calc\(\(1lh - 1cap\) \/ 2\);/);
		expect(rule).toMatch(/min-height:\s*1lh;/);
	});
});

describe("every text item in an icon row carries cap-centred", () => {
	// How many times each file writes the class in code: one per text item in
	// the rows it builds. A count rather than "appears somewhere", so a row
	// that loses one of two (the method badge, not the name) still fails.
	const cases: [label: string, path: string, count: number][] = [
		// The collection's name; its count is `DrawerSectionCount`, below.
		["CollectionItem name", "modules/collections/CollectionItem.tsx", 1],
		["RequestItem method and name", "modules/collections/RequestItem.tsx", 2],
		// The count, and the title in both header shapes (button and heading).
		["DrawerSection title and count", "components/shared/DrawerSection.tsx", 3],
		[
			"VariablesCategoryTree Globals and environment",
			"modules/variables/sidebar/VariablesCategoryTree.tsx",
			2,
		],
		["SettingsCategoryTree category", "modules/settings/sidebar/SettingsCategoryTree.tsx", 1],
		// The title, the missing-field line and the summary.
		["ElementList header", "components/shared/ElementList/index.tsx", 3],
	];

	it.each(cases)("%s: %s carries it %i time(s)", (_label, path, count) => {
		const source = readFileSync(join(srcRoot, path), "utf8");
		expect(source.length).toBeGreaterThan(300);
		const hits = stripComments(source).match(/\bcap-centred\b/g) ?? [];
		expect(hits.length).toBe(count);
	});
});
