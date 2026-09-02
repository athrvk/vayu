/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every region the cycle names is a region something renders (#1219).
 *
 * `AppRegion` is a union of four names and `cycleRegionFocus` walks whatever
 * carries the attribute, so the two halves cannot disagree at compile time: a
 * band that lost its marker in a refactor would simply drop out of the cycle,
 * silently, and F6 would move focus somewhere plausible. That is this
 * codebase's most repeated defect wearing a different hat - a value declared in
 * one place and read in none.
 *
 * A scan rather than a render, because the four bands are never on screen
 * together in a test: the title bar is Electron-only, and the two sidebars
 * unmount when closed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REGION_ATTRIBUTE, type AppRegion } from "./region-focus";

const here = dirname(fileURLToPath(import.meta.url));

function layoutSources(): string[] {
	return globSync("*.tsx", { cwd: here })
		.filter((f) => !/\.test\.tsx$/.test(f))
		.map((f) => join(here, f));
}

/**
 * `data-app-region={"drawer" satisfies AppRegion}` - the name it marks.
 *
 * Built from `REGION_ATTRIBUTE` rather than spelling the attribute again: JSX
 * needs a literal attribute name, so the four bands cannot read the constant,
 * and a scan that also hardcoded it would go quietly green if the constant were
 * ever renamed - matching nothing and finding no offenders.
 */
const MARKER = new RegExp(`${REGION_ATTRIBUTE}=\\{"([a-z]+)" satisfies AppRegion\\}`, "g");

function markedRegions(): string[] {
	return layoutSources().flatMap((file) =>
		Array.from(readFileSync(file, "utf8").matchAll(MARKER), (m) => m[1])
	);
}

/**
 * The union, restated - a type cannot be enumerated at run time. `satisfies`
 * makes this a compile error if a name is dropped from `AppRegion`, and the
 * cases below catch one being added without a band to mark.
 */
const EXPECTED = ["banner", "drawer", "main", "context"] satisfies AppRegion[];

describe("the shell marks every region the cycle knows about", () => {
	it("scans a non-empty set of layout files", () => {
		// A guard that cannot fail reads as coverage and is worse than none.
		expect(layoutSources().length).toBeGreaterThan(5);
	});

	it("marks each region exactly once", () => {
		expect(markedRegions().sort()).toEqual([...EXPECTED].sort());
	});

	it("catches a marker when there is one", () => {
		// The scan's own mutation check: the pattern has to match the shape it
		// counts, or agreement above means nothing.
		const sample = '<main data-app-region={"main" satisfies AppRegion} className="x">';
		expect(Array.from(sample.matchAll(MARKER), (m) => m[1])).toEqual(["main"]);
	});
});
