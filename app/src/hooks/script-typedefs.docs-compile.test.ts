/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the documentation's own `pm.*` examples against
 * the declarations the engine generates for them.
 *
 * The engine's `script_types_test.cpp` guards the derivation by asserting on
 * substrings of the generated text - every listed member appears, the chain
 * returns the chain, an optional field keeps its type. That is worth having and
 * it cannot catch this class: a declaration can contain every right name and
 * still not type-check. Four defects survived it (#463), and compiling the docs
 * is how all four were found - `pm.cookies.jar()` declared twice with the
 * `object` overload winning, every jar method's signature emptied by the `()`
 * in its own label, `pm.info.eventName` typed `void`, and two `pm.expect`
 * chains shorter than the prose beside them claimed.
 *
 * So the documentation and the declarations hold each other up: a `pm.*`
 * example the editor would squiggle fails here, and so does a declaration that
 * stops describing what the docs recommend.
 *
 * **Where the two sides meet.** This needs a TypeScript compiler, which ctest
 * does not have; the generator needs the engine, which vitest cannot run. So
 * the engine checks in its output at
 * `engine/tests/fixtures/script-typedefs.d.ts` and pins it byte-for-byte
 * (`ScriptTypesTest.TheCheckedInDeclarationsMatchTheGenerator`), the same shape
 * as `variable-resolution-conformance.json`. One artifact, two readers, and the
 * gtest is what stops the copy drifting - regenerate with
 * `VAYU_UPDATE_SCRIPT_TYPEDEFS=1 ctest --preset linux-dev -R ScriptTypes`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import { SCRIPT_COMPILER_OPTIONS, SUPPRESSED_DIAGNOSTICS } from "./useScriptTypeDefinitions";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const DECLARATIONS_PATH = join(repoRoot, "engine", "tests", "fixtures", "script-typedefs.d.ts");

/** The two pages whose `pm.*` blocks are the contract. */
const DOC_PATHS = [
	join(repoRoot, "docs", "engine", "scripting.md"),
	join(repoRoot, "docs", "app", "pm-api-compatibility.md"),
];

interface DocBlock {
	doc: string;
	line: number;
	source: string;
}

/**
 * Every fenced `javascript` block that touches the `pm` surface. Blocks are
 * compiled one at a time rather than concatenated: each is its own script, and
 * two of them declaring `const jar` is correct documentation that a single
 * merged file would reject.
 */
function extractPmBlocks(path: string): DocBlock[] {
	const lines = readFileSync(path, "utf8").split("\n");
	const doc = path.slice(repoRoot.length + 1);
	const blocks: DocBlock[] = [];

	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (start === -1) {
			if (lines[i] === "```javascript") start = i;
			continue;
		}
		if (lines[i] !== "```") continue;
		const source = lines.slice(start + 1, i).join("\n");
		if (source.includes("pm.")) {
			blocks.push({ doc, line: start + 2, source });
		}
		start = -1;
	}
	return blocks;
}

const SCRIPT_NAME = "/script.js";
const DECLARATIONS_NAME = "/pm.d.ts";

const COMPILER_OPTIONS: ts.CompilerOptions = {
	...SCRIPT_COMPILER_OPTIONS,
	// Monaco's bundled enum stops at ES2020; the hook targets ESNext for the
	// same reason, and `lib` above pins the surface either way.
	target: ts.ScriptTarget.ESNext,
};

/**
 * One program per block - each is its own script, and two of them declaring
 * `const jar` is correct documentation a single merged file would reject. What
 * is shared is the *work around* it: `lib.es2022.d.ts` and its references plus
 * the declarations are the overwhelming majority of the cost and are identical
 * every time, so they are parsed once and handed to every program, and each
 * program reuses the last one's structure. Uncached, the 54 blocks take ~19s;
 * cached, under 2 on Linux - and the Windows runner is several times slower
 * again, which is what the explicit timeout at the bottom of this file is for.
 */
function createCompiler(declarations: string) {
	const defaultHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
	const cache = new Map<string, ts.SourceFile | undefined>();

	let current: ts.SourceFile | undefined;

	const host: ts.CompilerHost = {
		...defaultHost,
		getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
			if (fileName === SCRIPT_NAME) return current;
			if (!cache.has(fileName)) {
				cache.set(
					fileName,
					fileName === DECLARATIONS_NAME
						? ts.createSourceFile(fileName, declarations, languageVersion, true)
						: defaultHost.getSourceFile(
								fileName,
								languageVersion,
								onError,
								shouldCreate
							)
				);
			}
			return cache.get(fileName);
		},
		fileExists: (fileName) =>
			fileName === DECLARATIONS_NAME ||
			fileName === SCRIPT_NAME ||
			defaultHost.fileExists(fileName),
		readFile: (fileName) =>
			fileName === DECLARATIONS_NAME ? declarations : defaultHost.readFile(fileName),
		writeFile: () => {},
	};

	let previous: ts.Program | undefined;

	/**
	 * The diagnostics the editor would show, so the codes the app suppresses are
	 * dropped here too. Both come from the editor holding a fragment while the
	 * engine runs something larger: 1108 (top-level `return`, legal because the
	 * engine wraps the script in an IIFE) and 2304 (a name a collection-level
	 * script part declared).
	 */
	return function compile(block: DocBlock): string[] {
		current = ts.createSourceFile(
			SCRIPT_NAME,
			block.source,
			COMPILER_OPTIONS.target ?? ts.ScriptTarget.ESNext,
			true
		);
		// `oldProgram` lets the compiler keep the structure for every file that
		// did not change, which is all of them but the block - the same
		// mechanism a watching editor uses between keystrokes.
		const program = ts.createProgram({
			rootNames: [DECLARATIONS_NAME, SCRIPT_NAME],
			options: COMPILER_OPTIONS,
			host,
			oldProgram: previous,
		});
		previous = program;
		const script = program.getSourceFile(SCRIPT_NAME);
		if (!script) throw new Error("the block never reached the compiler");

		return [
			...program.getSemanticDiagnostics(script),
			...program.getSyntacticDiagnostics(script),
		]
			.filter((d) => !SUPPRESSED_DIAGNOSTICS.includes(d.code))
			.map((d) => {
				const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
				const at =
					d.file && d.start !== undefined
						? d.file.getLineAndCharacterOfPosition(d.start).line
						: 0;
				const offending = block.source.split("\n")[at] ?? "";
				return `${block.doc}:${block.line + at}: TS${d.code}: ${message}\n    ${offending.trim()}`;
			});
	};
}

describe("the documented pm.* examples compile against the generated declarations", () => {
	const declarations = readFileSync(DECLARATIONS_PATH, "utf8");
	const blocks = DOC_PATHS.flatMap(extractPmBlocks);

	/*
	 * A version of this that silently found zero code blocks - a renamed doc, a
	 * fence spelled ```js - would pass forever while checking nothing. The
	 * corpus was 54 blocks when this landed; the floor is well under that so
	 * ordinary editing does not trip it, and far above zero.
	 */
	it("reads a corpus worth compiling", () => {
		expect(blocks.length).toBeGreaterThan(40);
		expect(declarations).toContain("declare const pm: {");
		expect(declarations.length).toBeGreaterThan(20000);
	});

	/*
	 * The only test in this suite that needs a timeout of its own. Running the
	 * TypeScript compiler over 54 blocks is real work - about 2s on a Linux
	 * developer machine, and the Windows CI runner took past vitest's 5s default
	 * on the first attempt at this. The number is a ceiling for a hang, not a
	 * budget: if this starts approaching it, the compiler is being asked to redo
	 * something the caches above should be holding.
	 */
	it("reports no errors on any of them", () => {
		const compile = createCompiler(declarations);
		const errors = blocks.flatMap(compile);
		expect(errors.join("\n")).toBe("");
	}, 120_000);
});
