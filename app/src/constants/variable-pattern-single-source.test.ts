/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One `{{name}}` matcher in the app, imported everywhere it is used.
 *
 * The app reached four textually identical copies of `/\{\{([^{}]+)\}\}/g`
 * (issue #227), and the count survived a refactor that changed *which* files
 * held them - #231 deleted one copy and introduced another. Identical copies
 * are not a style complaint: the engine owns interpolation now, the renderer's
 * job is to preview exactly what the engine will substitute, and a copy is a
 * place the preview can drift from that without anything failing.
 *
 * So the guard is on the shape, not the count: a regex literal that starts by
 * matching a literal `{{` may only be declared in `constants/variables.ts`.
 * Import `VARIABLE_PATTERN` (or `VARIABLE_SPLIT_PATTERN`) instead.
 *
 * Test files are scanned too - a copy there pins nothing and rots the same way.
 * `EXEMPT` is for patterns that are deliberately *different*, and each entry
 * has to say how.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

/** The one file allowed to declare a `{{`-matching literal. */
const CANONICAL = "constants/variables.ts";

/**
 * Deliberately different patterns, with the difference named. Empty since the
 * import parsers moved engine-side (issue #877): the one exemption was
 * `var-normalize.ts`, whose `{{ _.x }}` rewrite is now
 * `engine/src/core/path_template.cpp`.
 */
const EXEMPT = new Set<string>();

/**
 * A regex literal that matches a whole `{{...}}` token.
 *
 * Both braces are required: a pattern that only looks for `{{` is finding an
 * opening brace (a label, a half-typed token), which is a different question
 * and has its own helper in `VariableInput`.
 */
const DECLARES_BRACE_PATTERN = /\/(?:\^)?\\\{\\\{.*\\\}\\\}/;

/**
 * `globSync` yields the host's separator - `constants\variables.ts` on Windows,
 * which is how the first version of this guard passed on Linux and macOS while
 * reporting the canonical file itself as a stray on Windows.
 *
 * Splitting on **both** separators rather than on `path.sep` is what makes that
 * testable: the normalization no longer depends on the host, so the Windows
 * input can be exercised from any runner. Every path in this file is
 * `/`-separated from here on - the allowlists, the `CANONICAL` comparison and
 * the reported offences - and `absolute()` is the only place that goes back to
 * the host's shape.
 */
function toPosix(path: string): string {
	return path.split(/[\\/]/).join("/");
}

function absolute(file: string): string {
	return join(srcRoot, ...file.split("/"));
}

function sourceFiles(): string[] {
	return globSync("**/*.{ts,tsx}", { cwd: srcRoot })
		.map(toPosix)
		.filter((f) => !EXEMPT.has(f));
}

/** Blank comment bodies, keeping newlines so reported line numbers still land. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function declarations(): string[] {
	const found: string[] = [];
	for (const file of sourceFiles()) {
		const source = readFileSync(absolute(file), "utf8");
		stripComments(source)
			.split(/\r?\n/)
			.forEach((line, i) => {
				if (DECLARES_BRACE_PATTERN.test(line))
					found.push(`${file}:${i + 1} ${line.trim()}`);
			});
	}
	return found;
}

describe("VARIABLE_PATTERN is declared once", () => {
	it("scans a non-empty set of files", () => {
		// A source scan that reads nothing passes forever and reads as coverage.
		expect(sourceFiles().length).toBeGreaterThan(100);
	});

	it("reads the same on a Windows runner as on a POSIX one", () => {
		// Both branches from either host: the `\` form is what globSync hands
		// this file on Windows, and comparing it against a `/`-separated
		// `CANONICAL` is what made the first version of this guard report the
		// canonical file as a stray there. Asserting `sourceFiles()` alone
		// would only ever exercise the host's own separator.
		expect(toPosix("constants\\variables.ts")).toBe(CANONICAL);
		expect(toPosix("constants/variables.ts")).toBe(CANONICAL);
		expect(sourceFiles().every((f) => !f.includes("\\"))).toBe(true);
	});

	it("finds the canonical declaration, so the matcher works", () => {
		// Without this the guard could pass by failing to recognise a literal
		// it was written to recognise.
		expect(declarations().some((d) => d.startsWith(`${CANONICAL}:`))).toBe(true);
	});

	it("finds no other file declaring a `{{` matcher", () => {
		const strays = declarations().filter((d) => !d.startsWith(`${CANONICAL}:`));
		expect(strays.join("\n")).toBe("");
	});

	it("keeps every exemption pointing at a file that exists", () => {
		// An exemption for a deleted file is an exemption nobody notices is
		// wrong; it would silently cover a future file at the same path.
		for (const f of EXEMPT) {
			expect(() => readFileSync(absolute(f), "utf8")).not.toThrow();
		}
	});
});

describe("the shared pattern is safe to share", () => {
	it("is never used with a stateful API", () => {
		// `.test()` / `.exec()` on a `/g` regex advances lastIndex, so the next
		// caller of the shared object starts mid-string. `constants/variables.ts`
		// exports `isVariableToken` for the boolean case for exactly this reason.
		const offences: string[] = [];
		for (const file of sourceFiles()) {
			const source = stripComments(readFileSync(absolute(file), "utf8"));
			source.split(/\r?\n/).forEach((line, i) => {
				// The lookbehind keeps the non-global `CONTAINS_VARIABLE_PATTERN`
				// out: it is safe with `.test()`, which is why it exists.
				if (/(?<![A-Z_])VARIABLE_(?:SPLIT_)?PATTERN\.(?:test|exec)\s*\(/.test(line)) {
					offences.push(`${file}:${i + 1} ${line.trim()}`);
				}
			});
		}
		expect(offences.join("\n")).toBe("");
	});
});
