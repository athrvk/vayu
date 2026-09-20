/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The eyebrow class string is typed out in exactly one place.
 *
 * `EYEBROW_CLASS` was extracted precisely because the value had been re-typed
 * across the app and drifted - the two in `HeadersViewer` were `text-sm ...
 * tracking-wide` and `text-xs ... uppercase`, neither of them the 11px step the rest
 * of the app used. Extracting a constant does not stop that on its own: twelve
 * byte-for-byte copies of the full class string were still sitting in the
 * settings panels, the welcome screens and the GraphQL body pane, and one in
 * `InheritanceChain` had drifted to `tracking-[0.07em]`. A constant nobody is
 * required to use is a suggestion.
 *
 * The rule this guards is narrow on purpose: **the exact string may appear
 * once**. It says nothing about the other uppercase labels in the tree, and
 * should not - `CollectionDetail/shared.tsx` and `ChainCard` run a denser 10px
 * tier, and `ResponseBody`'s content-type chip is 11px *without* the semibold
 * because it sits inline in a 32px toolbar band. Those are different things
 * that happen to be uppercase, not copies of this one.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import { stripComments } from "@/lib/strip-comments.testkit";

import { EYEBROW_CLASS, EYEBROW_XS_CLASS } from "./eyebrow";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

/** Where the constant itself is declared - the one legal occurrence. */
const DECLARATION = join(here, "eyebrow.tsx");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

describe("EYEBROW_CLASS is written once", () => {
	const files = walk(srcRoot).filter((f) => !f.endsWith("eyebrow.test.ts"));

	it("scanned a non-empty tree", () => {
		// A guard that reads nothing passes forever.
		expect(files.length).toBeGreaterThan(100);
		expect(EYEBROW_CLASS).toContain("text-label");
	});

	it("no file re-types the full class string", () => {
		const offenders = files
			.filter((f) => f !== DECLARATION)
			.filter((f) => readFileSync(f, "utf8").includes(EYEBROW_CLASS))
			.map((f) => relative(srcRoot, f));

		expect(offenders).toEqual([]);
	});

	it("the declaration still holds it, so the scan is looking for something real", () => {
		// Composed from a shared base since the `xs` step arrived (#1692), so the
		// resolved string is not in the source any more - each part is, and the
		// exported constant is asserted to still resolve to it.
		const declaration = readFileSync(DECLARATION, "utf8");
		for (const part of EYEBROW_CLASS.split(" ")) expect(declaration).toContain(part);
		expect(EYEBROW_CLASS).toBe(
			"text-label font-semibold uppercase tracking-[0.06em] text-muted-foreground"
		);
		expect(EYEBROW_XS_CLASS).toBe(EYEBROW_CLASS.replace("text-label", "text-micro"));
	});
});

/**
 * The rule, not a copy of the literal (#1692).
 *
 * The scan above only ever caught a *byte-for-byte* copy of `EYEBROW_CLASS`,
 * and that is not the shape the drift took. The twenty hand-rolled section
 * labels this sweep converted were spread across three sizes
 * (`text-[10px]`, `text-[11px]`, `text-xs`), five tracking values
 * (`tracking-wide`, `-wider`, `[0.06em]`, `[0.07em]`, `[0.08em]`) and two
 * weights - every one of them a near-miss the old scan waved through.
 *
 * What they had in common is the shape: `uppercase` and a `tracking-` utility
 * in one class string. That is a section label in this app, and a section label
 * is `Eyebrow`, which takes `size="xs"` for the 10px tier.
 *
 * Comments are stripped first, because a comment explaining why a label is not
 * an eyebrow names both classes and would otherwise be the violation.
 */
const EXEMPT: Record<string, string> = {
	// A value with a `text-transform`, not a label: the console gutter's tone
	// marker ("LOG", "ERR"), the `off` / `not defined` markers a variable row
	// carries beside a name, and the response pane's detected content type,
	// which sits inline in a 32px band and is deliberately unweighted.
	"modules/request-builder/components/ResponseViewer/console/ScriptSection.tsx":
		"console gutter tone marker, one text node per output row",
	"components/layout/context-bar/VariablesSection.tsx": "`not defined` marker beside a value",
	"components/layout/context-bar/CollectionVariablesSection.tsx": "`off` marker beside a value",
	"components/shared/response-viewer/ResponseBody.tsx":
		"detected content type, inline in the toolbar band and unweighted on purpose",
	// An inline field label on one line with its value, at body-adjacent size -
	// `Eyebrow` is a block above a group.
	"modules/request-builder/components/RequestTabs/panels/ParamsPanel.tsx":
		"`Sends` labels the line it shares, rather than the block below it",
	// A `<tr>`. The primitive is a `<p>`, and a paragraph is not table markup.
	"modules/variables/main/VariableTableEditor.tsx": "table header row",
};

describe("no hand-rolled eyebrow", () => {
	const tsx = walk(srcRoot).filter((f) => f.endsWith(".tsx") && !/\.test\.tsx?$/.test(f));

	/** Every class-string literal in the file, both quoting forms. */
	const classStrings = (source: string): string[] =>
		[...stripComments(source).matchAll(/"[^"\n]*"|`[^`]*`/g)].map(([literal]) => literal);

	const hits = tsx
		.map((file) => ({
			file: relative(srcRoot, file).split(sep).join("/"),
			labels: classStrings(readFileSync(file, "utf8")).filter(
				(literal) => literal.includes("uppercase") && /\btracking-/.test(literal)
			),
		}))
		.filter(({ labels }) => labels.length > 0);

	it("scanned a non-empty tree", () => {
		// The same proof the scan above takes: a walk that found nothing, or a
		// regex that stopped matching, must fail here rather than pass empty.
		expect(tsx.length).toBeGreaterThan(100);
		expect(hits.length).toBeGreaterThan(0);
	});

	it("only the primitive and the named exemptions combine uppercase with tracking", () => {
		const offenders = hits
			.filter(({ file }) => file !== "components/ui/eyebrow.tsx")
			.filter(({ file }) => !(file in EXEMPT))
			.map(
				({ file, labels }) =>
					`${file}  ${labels.join(" | ")}\n  ` +
					`A section label is <Eyebrow> (size="xs" for the 10px tier), not a ` +
					`hand-rolled uppercase+tracking class string.`
			);

		expect(offenders.join("\n")).toBe("");
	});

	it.each(Object.keys(EXEMPT))("%s still holds the label it is exempted for", (file) => {
		// An exemption that stopped applying is a licence nobody is using. It
		// drops off the list rather than quietly covering whatever lands there
		// next.
		expect(
			hits.find((hit) => hit.file === file),
			`${file} no longer matches`
		).toBeDefined();
	});
});
