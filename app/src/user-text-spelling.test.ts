/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The spellings `docs/ux-writing.md` fixes, held over every string the app's
 * sources carry (#2299). Three rules, each a spelling a reader sees as
 * inconsistency rather than as a mistake:
 *
 *  - a settings path is written `Settings › Files`, never `Settings > Files`;
 *  - the tool is "cURL" in a sentence ("a cURL command", "a cURL request");
 *  - an ellipsis is the one character `…`, never three full stops after a word.
 *
 * The strings come from `ui-strings.testkit.ts`, which already leaves out
 * comments, logs, tests and `electron/mcp/**`. The command `curl` itself, the
 * code-generator id `"curl"` and a libcurl handle are not sentences about the
 * tool, so the rule names the two nouns the sentences use.
 */

import { describe, it, expect } from "vitest";
import { uiStrings } from "@/lib/ui-strings.testkit";

// ---------------------------------------------------------------------------
// The detectors, exported for the cases at the bottom of this file.
// ---------------------------------------------------------------------------

/** A path of names joined with `>`, which reads as a comparison or a quote. */
export function hasAsciiPathSeparator(text: string): boolean {
	return /Settings >/.test(text);
}

/** Case-sensitive on purpose: "cURL command" is the spelling being asked for. */
export function hasLowercaseCurl(text: string): boolean {
	return /\bcurl (command|request)/.test(text);
}

/**
 * Three full stops straight after a letter. A spread, a regex, a `"..."` code
 * sample and a GraphQL fragment all put something else before the dots.
 */
export function hasAsciiEllipsis(text: string): boolean {
	return /\p{L}\.\.\.(?!\.)/u.test(text);
}

const RULES: readonly { readonly name: string; readonly breaks: (text: string) => boolean }[] = [
	{ name: "Settings > path (write Settings ›)", breaks: hasAsciiPathSeparator },
	{ name: "lowercase curl in a sentence (write cURL)", breaks: hasLowercaseCurl },
	{ name: "ASCII ellipsis (write …)", breaks: hasAsciiEllipsis },
];

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const { files, strings } = uiStrings();

const breaches = strings.flatMap((entry) =>
	RULES.filter(({ breaks }) => breaks(entry.text)).map(({ name }) => ({
		report: `${entry.file}:${entry.line} ${name}: ${JSON.stringify(entry.text)}`,
	}))
);

describe("the user-text spelling scan", () => {
	it("reads a real tree", () => {
		expect(files.length).toBeGreaterThan(500);
		expect(strings.length).toBeGreaterThan(2000);
		// A string that carries the right spelling, so a scan that read nothing
		// of the tree's text cannot pass for one that found no breach.
		expect(strings.some(({ text }) => text === "Import environment…")).toBe(true);
	});

	it("finds no breach", () => {
		expect(
			breaches.map(({ report }) => report).join("\n"),
			"Spell it the way docs/ux-writing.md says: `Settings ›`, `cURL`, `…`."
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// The detectors, one bad and one good per rule.
// ---------------------------------------------------------------------------

describe("the settings path rule", () => {
	it("refuses an ASCII chevron after Settings", () => {
		expect(hasAsciiPathSeparator("allow its folder in Settings > Files.")).toBe(true);
		expect(hasAsciiPathSeparator("System Settings > General > Login Items")).toBe(true);
	});

	it("passes the chevron the guide asks for", () => {
		expect(hasAsciiPathSeparator("Settings › Dashboard › SLO threshold")).toBe(false);
	});
});

describe("the cURL rule", () => {
	it("refuses lowercase curl before command or request", () => {
		expect(hasLowercaseCurl("Paste a URL or a curl command")).toBe(true);
		expect(hasLowercaseCurl("Import a curl request")).toBe(true);
	});

	it("passes cURL, and the tool's other nouns", () => {
		expect(hasLowercaseCurl("Paste a URL or a cURL command")).toBe(false);
		expect(hasLowercaseCurl("curl handles")).toBe(false);
		expect(hasLowercaseCurl("libcurl request")).toBe(false);
		expect(hasLowercaseCurl("curl -X POST https://api.example.com")).toBe(false);
	});
});

describe("the ellipsis rule", () => {
	it("refuses three full stops after a letter", () => {
		expect(hasAsciiEllipsis("Allow folder...")).toBe(true);
		expect(hasAsciiEllipsis("Move to... ")).toBe(true);
		expect(hasAsciiEllipsis("Reading the document... done")).toBe(true);
	});

	it("passes the ellipsis character, and dots after anything else", () => {
		expect(hasAsciiEllipsis("Allow folder…")).toBe(false);
		expect(hasAsciiEllipsis('pm.variables.replaceIn("...")')).toBe(false);
		expect(hasAsciiEllipsis("... on Query")).toBe(false);
	});
});
