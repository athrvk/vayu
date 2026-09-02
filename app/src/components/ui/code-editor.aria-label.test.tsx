/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every editor says what it is.
 *
 * Monaco's default accessible name is "Editor content", so a dozen panes with
 * no `ariaLabel` all announce the same three words - the request body, the test
 * script and the response are one control to a screen reader. `CodeEditorProps`
 * makes the prop required, which is the strong half of this: a mount site
 * cannot compile without one.
 *
 * The type cannot say the labels are *distinct*, though, and a copy-pasted
 * mount is how they stop being. That is what the scan below holds, along with
 * refusing an empty string - which satisfies the type and names nothing.
 */

import { describe, it, expect } from "vitest";
import { openingTags, summarize } from "@/lib/jsx-opening-tags.testkit";

const sources = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

/** Mount sites, minus the ones in test files - those repeat labels on purpose. */
const mounts = Object.entries(sources)
	.filter(([path]) => !path.includes(".test."))
	.flatMap(([path, src]) =>
		openingTags(src as string, "CodeEditor").map((tag) => ({ path, tag }))
	);

/** `ariaLabel="Request body"` → `Request body`; a bound expression → null. */
function literalLabel(tag: string): string | null {
	return /ariaLabel="([^"]*)"/.exec(tag)?.[1] ?? null;
}

const hasLabel = (tag: string) => /\bariaLabel[=\s]/.test(tag);

describe("every CodeEditor names itself", () => {
	it("finds mount sites to check (guards the scan itself)", () => {
		// A renamed component or a broken glob matches nothing, and every
		// assertion below then passes over an empty list. The floor sits well
		// under the real count so retiring one pane does not trip it.
		expect(mounts.length).toBeGreaterThan(4);
	});

	it("passes an ariaLabel at every mount", () => {
		const offenders = mounts
			.filter(({ tag }) => !hasLabel(tag))
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});

	it("gives no editor an empty name, which the type would accept", () => {
		const offenders = mounts
			.filter(({ tag }) => literalLabel(tag)?.trim() === "")
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});

	it("gives no two editors the same name", () => {
		// Only the literal labels: the two script panels take theirs from
		// `SCRIPT_VARIANTS` and the collection tab from its `kind`, and a scan
		// cannot follow either - the same limit `app/CLAUDE.md` records for
		// class names arriving in a variable.
		const literals = mounts
			.map(({ path, tag }) => ({ path, label: literalLabel(tag) }))
			.filter((m): m is { path: string; label: string } => m.label !== null);
		const seen = new Map<string, string>();
		const duplicates: string[] = [];
		for (const { path, label } of literals) {
			const first = seen.get(label);
			if (first) duplicates.push(`"${label}" at ${first} and ${path}`);
			else seen.set(label, path);
		}
		expect(duplicates).toEqual([]);
	});
});
