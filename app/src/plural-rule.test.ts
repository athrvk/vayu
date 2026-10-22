/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The plural rule of `docs/ux-writing.md` (#2307): a count agrees with its noun
 * through `pluralize` / `pickByCount` (`@/modules/dashboard/utils/format`), which
 * pick by `Intl.PluralRules`. Two hand-built shapes are refused:
 *
 *  - "(s)" glued to a word in a string a user reads ("1 request(s)");
 *  - a ternary on `=== 1` / `!== 1` whose branches differ only by the plural
 *    suffix (`n === 1 ? "row" : "rows"`, `n === 1 ? "" : "s"`, `{n} cookie{n === 1 ? "" : "s"}`)
 *    or are a verb / pronoun pair (`"is"` / `"are"`, `"it"` / `"them"`).
 *
 * A whole sentence that changes more than its noun is `pickByCount`'s job and is
 * not seen by the ternary scan (its branches do not differ by a suffix); a
 * sentence written out that way is still correct English.
 *
 * `electron/` is out of reach of the ternary scan on purpose: the main process
 * cannot import from `src/`, so it has no `pluralize` to call.
 */

import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";
import { uiStrings } from "@/lib/ui-strings.testkit";

// ---------------------------------------------------------------------------
// The detectors.
// ---------------------------------------------------------------------------

/** `word(s)` / `word(es)`; `http(s)` and `ws(s)` are protocols, not plurals. */
const PAREN_PLURAL = /\b(?!https?\b|wss?\b)[A-Za-z]{2,}\((?:s|es)\)/;

export function parenPlural(text: string): string | null {
	return PAREN_PLURAL.exec(text)?.[0] ?? null;
}

const STRING_BRANCH = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`";
const BRANCH = `(?:${STRING_BRANCH}|[A-Za-z_$][\\w$]*)`;
/** `x === 1 ? a : b`, across lines; the operator tells which branch is the singular. */
const COUNT_TERNARY = new RegExp(
	`(===|!==)\\s*1\\s*\\?\\s*(${BRANCH})\\s*:\\s*(${BRANCH})(?![\\w$.(\\[])`,
	"g"
);

/** What a branch says: a string's body, or `${name}` for a bare identifier. */
function branchText(branch: string): string {
	const quote = branch[0];
	if (quote === '"' || quote === "'" || quote === "`") return branch.slice(1, -1);
	return `\${${branch}}`;
}

/** "1 service" / "${n} services" differ by the count, which is not the noun. */
function withoutCount(singular: string, other: string): [string, string] {
	return [
		singular.replace(/^1(?=\s)/, "").trim(),
		other.replace(/^\$\{[^}]*\}(?=\s)/, "").trim(),
	];
}

const AGREEMENT_PAIRS: readonly (readonly [singular: string, other: string])[] = [
	["is", "are"],
	["was", "were"],
	["has", "have"],
	["does", "do"],
	["it", "them"],
	["its", "their"],
	// A verb that takes the plural's "s" after a singular noun: "1 request records".
	["s", ""],
];

/** `other` is `singular` with the regular plural suffix, in the forms English uses. */
function isRegularPlural(singular: string, other: string): boolean {
	if (other === `${singular}s` || other === `${singular}es`) return true;
	return singular.endsWith("y") && other === `${singular.slice(0, -1)}ies`;
}

function isPluralPair(singular: string, other: string): boolean {
	if (singular === other) return false;
	if (isRegularPlural(singular, other)) return true;
	return AGREEMENT_PAIRS.some(([one, many]) => one === singular && many === other);
}

export interface PluralTernary {
	readonly line: number;
	readonly text: string;
}

/** Every count ternary in `code` (comments already stripped) that spells a plural by hand. */
export function pluralTernaries(code: string): PluralTernary[] {
	const found: PluralTernary[] = [];
	for (const match of code.matchAll(COUNT_TERNARY)) {
		const [text, operator, first, second] = match;
		const isOne = operator === "===" ? first : second;
		const isOther = operator === "===" ? second : first;
		const [singular, other] = withoutCount(branchText(isOne), branchText(isOther));
		if (!isPluralPair(singular, other)) continue;
		const line = code.slice(0, match.index).split("\n").length;
		found.push({ line, text: text.replace(/\s+/g, " ") });
	}
	return found;
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

const srcRoot = dirname(fileURLToPath(import.meta.url));

const sources = globSync("**/*.{ts,tsx}", { cwd: srcRoot })
	.map((file) => file.split(sep).join("/"))
	.filter(
		(file) =>
			!/\.(test|testkit)\.tsx?$/.test(file) &&
			!file.endsWith(".d.ts") &&
			!file.startsWith("test/")
	)
	.map((file) => ({ file, code: stripComments(readFileSync(join(srcRoot, file), "utf8")) }));

describe("plural-rule: the scan", () => {
	it("reads the app's source, not an empty list", () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(uiStrings().strings.length).toBeGreaterThan(1000);
		expect(sources.some(({ file }) => file === "modules/dashboard/utils/format.ts")).toBe(true);
	});

	it("recognises a hand-built plural, and leaves a sentence that changes more than its noun", () => {
		expect(parenPlural("1 request(s) failed")).toBe("request(s)");
		expect(parenPlural("Open the bucket(es)")).toBe("bucket(es)");
		expect(parenPlural("Use http(s) or ws(s)")).toBeNull();
		expect(parenPlural("Called as f(s) here")).toBeNull();
		expect(parenPlural("Nothing to pluralise")).toBeNull();

		const flagged = (code: string) => pluralTernaries(code).length;
		expect(flagged(`n === 1 ? "row" : "rows"`)).toBe(1);
		expect(flagged(`n !== 1 ? "rows" : "row"`)).toBe(1);
		expect(flagged(`{n} cookie{n === 1 ? "" : "s"}`)).toBe(1);
		expect(flagged(`n === 1 ? "s" : ""`)).toBe(1);
		expect(flagged(`n !== 1 ? "s" : ""`)).toBe(1);
		expect(flagged(`n === 1 ? "box" : "boxes"`)).toBe(1);
		expect(flagged(`n === 1 ? "query" : "queries"`)).toBe(1);
		expect(flagged("n === 1 ? 'row' : 'rows'")).toBe(1);
		expect(flagged("n === 1 ? label : `${label}s`")).toBe(1);
		expect(flagged(`n === 1 ? "1 service" : \`\${n} services\``)).toBe(1);
		expect(flagged(`n === 1 ? "is" : "are"`)).toBe(1);
		expect(flagged(`n === 1 ? "it" : "them"`)).toBe(1);
		expect(flagged(`n === 1\n\t? "has"\n\t: "have"`)).toBe(1);
		expect(flagged(`a.length === 1 ? "s" : ""\nb.length === 1 ? "" : "s"`)).toBe(2);
		expect(flagged(`n === 1 ? "a" : n`)).toBe(0);

		expect(flagged(`n === 1 ? "one thing" : "many things"`)).toBe(0);
		expect(
			flagged(`n === 1 ? "1 element is inherited" : \`\${n} elements are inherited\``)
		).toBe(0);
		expect(flagged(`n === 1 ? "On" : "Off"`)).toBe(0);
		expect(flagged(`n === 1 ? "same" : "same"`)).toBe(0);
		expect(flagged(`step === 1 ? 0 : regions.length - 1`)).toBe(0);
		expect(flagged(`n === -1 ? "row" : "rows"`)).toBe(0);
		expect(flagged(`n === 1 ? label : labels.plural`)).toBe(0);
	});

	it("reports the line of a ternary that starts on an earlier line than its branches", () => {
		const hits = pluralTernaries(`const a = 1;\nconst b = n === 1\n\t? "row"\n\t: "rows";`);
		expect(hits).toEqual([{ line: 2, text: `=== 1 ? "row" : "rows"` }]);
	});
});

describe("plural-rule: no count is pluralised by hand", () => {
	it('has no "(s)" in text a user reads', () => {
		const offenders = uiStrings()
			.strings.filter(({ text }) => parenPlural(text) !== null)
			.map(({ file, line, text }) => `${file}:${line} ${text}`);
		expect(offenders).toEqual([]);
	});

	it("has no ternary on `=== 1` that picks a plural suffix or agreement word", () => {
		const offenders = sources.flatMap(({ file, code }) =>
			pluralTernaries(code).map(({ line, text }) => `${file}:${line} ${text}`)
		);
		expect(offenders).toEqual([]);
	});
});
