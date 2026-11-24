/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A test ceiling is the owner's constant, and its docblock holds the rule, not
 * the value or the story of how it got there.
 *
 * A ceiling whose comment lists each raise ("16 was what #1216 left behind ...
 * 22 adds ContextRail's nav") is a second copy of the number that every raise
 * has to edit, and it is the shape that put 22 conflicts on one MCP test. The
 * measured value belongs in the failure message, where it is read when it is
 * wrong, and the history belongs to git.
 *
 * So this scans the test files and testkits for a ceiling constant - a `CEILING`, a
 * `*_CEILING` or a `CEILING_*` name, or a `maxBytes:` row - and refuses a
 * comment above it that carries a digit run of three or more (a measured
 * value), two or more issue numbers (a list of raises), or a verb that narrates
 * one. A single issue link is how a docblock says why the ceiling exists.
 */

import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TEST_FILES = ["src/**/*.{test,testkit}.{ts,tsx}", "electron/**/*.{test,testkit}.ts"];

const CEILING_NAME = String.raw`(?:CEILING|[A-Z0-9_]*_CEILING|CEILING_[A-Z0-9_]*)`;

/** `const CEILING = 22;`, or a `maxBytes: 8_100,` row that starts its line. */
const CEILING_DECLARATION = new RegExp(
	String.raw`^\s*(?:(?:export\s+)?(?:const|let|var)\s+(${CEILING_NAME})\b|(maxBytes)\s*:)`
);

/** A line that belongs to a comment block: `//`, `/*`, ` * ...` or ` *\/`. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

const ISSUE_REFERENCE = /#\d+/g;
const MEASURED_NUMBER = /\d(?:_?\d){2,}/;
const RAISE_VERB = /\b(?:raised|bumped|lifted|increased|grew|went up|up from)\b/i;

interface CeilingComment {
	readonly name: string;
	readonly line: number;
	readonly comment: string;
}

/**
 * Each ceiling declaration in `source` with the comment block above it. Ceilings
 * declared on consecutive lines share the block above the first, because that is
 * how a docblock is written for a pair.
 */
function ceilingComments(source: string): CeilingComment[] {
	const lines = source.split(/\r?\n/);
	const found: CeilingComment[] = [];
	lines.forEach((text, index) => {
		const match = CEILING_DECLARATION.exec(text);
		if (!match) return;
		let at = index - 1;
		while (at >= 0 && CEILING_DECLARATION.test(lines[at])) at--;
		const block: string[] = [];
		while (at >= 0 && COMMENT_LINE.test(lines[at])) block.unshift(lines[at--]);
		found.push({ name: match[1] ?? match[2], line: index + 1, comment: block.join("\n") });
	});
	return found;
}

/** What is wrong with a ceiling's comment, as a sentence, or `null` when nothing is. */
function whatIsWrong(comment: string): string | null {
	const references = comment.match(ISSUE_REFERENCE) ?? [];
	if (references.length > 1) return `lists ${references.length} issues, which is a raise history`;
	const words = comment.replace(ISSUE_REFERENCE, "");
	const number = MEASURED_NUMBER.exec(words);
	if (number) return `carries the number ${number[0]}; the failure message prints the value`;
	const verb = RAISE_VERB.exec(words);
	if (verb) return `narrates a raise ("${verb[0]}"); the history is in git`;
	return null;
}

function scannedFiles(): string[] {
	return (
		TEST_FILES.flatMap((pattern) => globSync(pattern, { cwd: appRoot }))
			// This file spells ceilings in fixtures to prove the scan finds them.
			.filter((file) => !file.endsWith("ceiling-docblock.guard.test.ts"))
			.map((file) => file.split("\\").join("/"))
	);
}

describe("test ceilings", () => {
	const files = scannedFiles();
	const ceilings = files.flatMap((file) =>
		ceilingComments(readFileSync(join(appRoot, file), "utf8")).map((entry) => ({
			file,
			...entry,
		}))
	);

	it("scans a real set of files and finds the ceilings the suite holds", () => {
		// Both floors, for the reason `timeouts.guard.test.ts` gives: a pattern
		// that matches no file, or a declaration spelling that matches no ceiling,
		// would pass the case below forever.
		expect(files.length).toBeGreaterThan(500);
		const where = (file: string) => ceilings.filter((entry) => entry.file === file);
		expect(where("src/components/a11y-suppressions.test.ts").map((e) => e.name)).toContain(
			"CEILING"
		);
		expect(where("electron/mcp/tool-list-budget.test.ts").map((e) => e.name)).toContain(
			"CEILING_WRITES_OFF"
		);
	});

	it("carry a docblock that states the rule and holds no value or raise history", () => {
		const findings = ceilings.flatMap(({ file, line, name, comment }) => {
			const wrong = whatIsWrong(comment);
			return wrong ? [`${file}:${line} ${name}: the comment above it ${wrong}`] : [];
		});
		expect(findings).toEqual([]);
	});
});

describe("the ceiling docblock reader", () => {
	const only = (source: string) => {
		const [entry, ...rest] = ceilingComments(source);
		expect(rest).toEqual([]);
		return entry;
	};

	it("finds each spelling of a ceiling and the comment above it", () => {
		expect(only("/** A budget. */\nconst CEILING = 22;").name).toBe("CEILING");
		expect(only("// A budget.\nexport const TOOL_CEILING = 1;").name).toBe("TOOL_CEILING");
		expect(only("/** A budget. */\nconst CEILING_WRITES_ON = 1;").name).toBe(
			"CEILING_WRITES_ON"
		);
		expect(only("/**\n * A budget.\n */\n\tmaxBytes: 5,").name).toBe("maxBytes");
		expect(only("/** A budget. */\nconst CEILING = 22;").comment).toContain("A budget.");
	});

	it("leaves a name that merely contains the word alone", () => {
		expect(ceilingComments("// 1234\nconst CEILINGS = {};")).toEqual([]);
		expect(ceilingComments("// 1234\nconst ceiling = 1;")).toEqual([]);
		expect(
			ceilingComments("// 1234\nexpect(call).toHaveBeenCalledWith({ url, maxBytes: 5 });")
		).toEqual([]);
	});

	it("gives a pair of ceilings the one block above the first", () => {
		const pair = ceilingComments("/** Bytes. */\nconst CEILING_A = 1;\nconst CEILING_B = 2;");
		expect(pair.map((entry) => entry.comment)).toEqual(["/** Bytes. */", "/** Bytes. */"]);
	});

	it("stops at a blank line, so a comment further up is not the ceiling's", () => {
		expect(only("// 12345 is elsewhere\n\nconst CEILING = 22;").comment).toBe("");
	});

	it("refuses a measured number, in any spelling of it", () => {
		expect(whatIsWrong("/** At most 156000 bytes. */")).toContain("156000");
		expect(whatIsWrong("/** At most 156_000 bytes. */")).toContain("156_000");
		expect(whatIsWrong("/** The count is 150. */")).toContain("150");
	});

	it("refuses two issues, which is a raise history, and allows one", () => {
		expect(whatIsWrong("/** Left by #1216, then #1323. */")).toContain("2 issues");
		expect(whatIsWrong("/** A fixed ceiling (#3558). */")).toBeNull();
	});

	it("refuses a verb that narrates a raise", () => {
		expect(whatIsWrong("/** Raised to 23 for #1872. */")).toContain("Raised");
		expect(whatIsWrong("/** It was bumped for the rail. */")).toContain("bumped");
		expect(whatIsWrong("/** Up from the old one. */")).toContain("Up from");
	});

	it("allows the rule: a fixed ceiling, remove rather than raise", () => {
		expect(
			whatIsWrong(
				"/**\n * The most directives this repository may carry: a fixed ceiling the owner\n * sets. Remove a suppression rather than raise it.\n */"
			)
		).toBeNull();
		expect(whatIsWrong("")).toBeNull();
	});

	it("fails a docblock that carries the old raise-by-raise list", () => {
		const old =
			"/**\n * A ceiling, not a count to hold: 16 was what #1216 left behind; 17 added the Dock's\n * worker-count tooltip (#1508); 22 adds ContextRail's nav (#1872).\n */\nconst CEILING = 22;";
		expect(whatIsWrong(only(old).comment)).not.toBeNull();
	});
});
