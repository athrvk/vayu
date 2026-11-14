/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An empty line in a pane is `EmptyState`, never a bare `<p>` (#3501).
 *
 * Five panes said "No ..." in a hand-sized `<p>`: three at `text-xs`, one in
 * italics, two with their own padding, none with the primitive's entry fade or
 * its `action` slot - so the two that were empty because of what the user had
 * typed ("No settings match", "No rows match") were dead ends with no way out.
 * `EmptyState variant="inline"` (`compact` for a dense surface) is the one
 * shape, and the doc's rule is that a filter's empty list offers "Clear the
 * filter".
 *
 * The scan reads every `<p>` whose first words are "No " or "Nothing matches"
 * in `modules/` and `components/`, and holds the context bar's `SectionEmpty`
 * wrapper - which hands its children to every section's empty line - to
 * rendering an `EmptyState`. It cannot see an empty line written as a `<span>`
 * or `<div>`, or one that arrives in a variable; those are a review matter. For
 * a rendered check of the filter sites see `SettingsCategoryTree.search.test.tsx`,
 * `send-with-row.test.tsx` and `SchemaExplorer.test.tsx`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { globSync } from "node:fs";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

const GUARDED = ["modules/**/*.tsx", "components/**/*.tsx"];

/**
 * A `<p>` that starts "No " and is not an empty state, by reason.
 *
 * Add one only with the reason beside it.
 */
const EXCLUDED: Record<string, string> = {
	// A lead-in over a list of suggestions ("No matches for ... Try one of
	// these:"), rendered above the rows it introduces inside the cmdk list.
	// There is something to show, so it is a sentence, not an empty state.
	"modules/palette/PaletteResults.tsx":
		"lead-in above the suggestions it introduces, not an empty list",
};

/**
 * `<p ...>` then, after any whitespace, text that opens with the word "No" or
 * with "Nothing matches" (a filter's empty line). Bare "Nothing" is not
 * matched: "Nothing to preview - Show is set to None" is a status.
 */
const BARE_NO_LINE = /<p\b[^>]*>\s*(?:No\s|Nothing matches)/g;

/** Where `SectionEmpty` is defined, the one wrapper a `<p>` scan cannot see through. */
const SECTION_FRAME = "components/layout/context-bar/Section.tsx";

function guardedFiles(): string[] {
	const excluded = new Set(Object.keys(EXCLUDED).map((f) => f.split("/").join(sep)));
	return GUARDED.flatMap((pattern) => globSync(pattern, { cwd: srcRoot }))
		.filter((f) => !/\.test\.tsx$/.test(f))
		.filter((f) => !excluded.has(f))
		.map((f) => join(srcRoot, f));
}

/** The offending `<p>` openers in one source, comments blanked first. */
function bareNoLines(source: string): string[] {
	return stripComments(source).match(BARE_NO_LINE) ?? [];
}

describe("an empty line is EmptyState, not a bare paragraph", () => {
	it("scans a non-empty set of files", () => {
		expect(guardedFiles().length).toBeGreaterThan(200);
	});

	it("keeps every exclusion on a file that still holds the line it excuses", () => {
		// An entry whose file no longer has the paragraph is an exemption nothing
		// uses, which would excuse the next one added there.
		for (const file of Object.keys(EXCLUDED)) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			expect(bareNoLines(source), file).not.toEqual([]);
		}
	});

	it("recognises the shape it guards", () => {
		expect(bareNoLines('<p className="text-xs">\n\tNo rows match.\n</p>')).toHaveLength(1);
		expect(bareNoLines("<p>No hosts yet.</p>")).toHaveLength(1);
		expect(bareNoLines('<p className="m-0">Nothing matches "{term}".</p>')).toHaveLength(1);
		expect(bareNoLines("<p>Nothing here.</p>")).toEqual([]);
		expect(bareNoLines("<p>Nothing to preview.</p>")).toEqual([]);
		expect(bareNoLines("{/* <p>No rows</p> */}")).toEqual([]);
	});

	it("keeps the context bar's SectionEmpty an EmptyState, not a bare paragraph", () => {
		const source = stripComments(readFileSync(join(srcRoot, SECTION_FRAME), "utf8"));
		const body = /function SectionEmpty\b[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
		// A guard that reads nothing passes forever.
		expect(body).toContain("function SectionEmpty");
		expect(body).toContain("<EmptyState");
		expect(body).not.toContain("<p");
	});

	it('finds no `<p>` that opens with "No " or "Nothing matches"', () => {
		const offences: string[] = [];
		for (const file of guardedFiles()) {
			const hits = bareNoLines(readFileSync(file, "utf8"));
			if (hits.length > 0) offences.push(relative(srcRoot, file));
		}
		expect(offences.join("\n")).toBe("");
	});
});
