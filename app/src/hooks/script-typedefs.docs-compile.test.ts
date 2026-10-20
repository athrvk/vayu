/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Cross-language conformance: the documentation's own `pm.*` examples against
 * the declarations the engine generates for them, and the declarations of the
 * names the sandbox lacks against the scripts that reach for them.
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
import ts from "typescript";
import {
	DOC_READING_GUARDS,
	ENGINE_READING_GUARDS,
	fromRepoRoot,
	repoRoot,
} from "@/lib/routed-inputs.testkit";
import { SCRIPT_COMPILER_OPTIONS, SUPPRESSED_DIAGNOSTICS } from "./useScriptTypeDefinitions";

/** Held in the testkit for the same reason the pages below are: CI routes it. */
const [DECLARATIONS_PATH] = ENGINE_READING_GUARDS.scriptTypedefs.paths.map(fromRepoRoot);

/**
 * The two pages whose `pm.*` blocks are the contract. They are held in the
 * testkit with the other guards' pages, because the workflow filter that routes
 * an edit to them back to this suite is compared against the union of all four
 * (`routed-inputs.test.ts`).
 */
const DOC_PATHS = DOC_READING_GUARDS.scriptTypedefs.paths.map(fromRepoRoot);

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

	let currentSource = "";

	const host: ts.CompilerHost = {
		...defaultHost,
		getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
			// Built from the options the compiler hands the host, not from a bare
			// target: they carry what decides whether the file is a module
			// (`moduleDetection`), and a script created without them is always a
			// global script - the editor's does not.
			if (fileName === SCRIPT_NAME) {
				return ts.createSourceFile(fileName, currentSource, languageVersion, true);
			}
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
	 * dropped here too: 1108 (top-level `return`, legal because the engine wraps
	 * the script in an IIFE) and 2304 (see SUPPRESSED_DIAGNOSTICS for why a
	 * correct script produces it).
	 */
	return function compile(block: DocBlock): string[] {
		currentSource = block.source;
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

/**
 * The names the sandbox lacks (`ABSENT_GLOBALS`) are declared so that using one
 * is an error with the replacement on hover. Whether it *is* an error depends on
 * the compiler options and on how a script uses the name, neither of which a
 * substring of the generated text can show - so these compile real scripts.
 */
describe("the names the sandbox lacks, as the editor reports them", () => {
	const declarations = readFileSync(DECLARATIONS_PATH, "utf8");
	const compile = createCompiler(declarations);
	const errorsOf = (source: string) => compile({ doc: "inline", line: 1, source }).join("\n");

	/*
	 * A script that declares one of these names itself is correct: the engine
	 * runs it inside a function, where the declaration is local. Compiled as a
	 * file in the global scope each line is "Cannot redeclare block-scoped
	 * variable" (2451), which is `moduleDetection` in SCRIPT_COMPILER_OPTIONS
	 * being what these lines hold up. Postman's legacy globals (`data`,
	 * `responseBody`, `tests`, ...) are declared for real since #2577 and absent
	 * names such as `URL` and `fetch` as `never`; a script's own declaration
	 * shadows either.
	 */
	it.each([
		["const data = pm.response.json();\ndata.id;"],
		["let responseBody = pm.response.text();\nJSON.parse(responseBody);"],
		["var request = pm.request;\nrequest.url;"],
		["const environment = pm.environment.toObject();\nenvironment.baseUrl;"],
		["const tests = [];\ntests.push(1);"],
		["function postman() { return 1; }\npostman();"],
		["const URL = pm.request.url;\nURL.host;"],
		["function fetch(url) { return url; }\nfetch('x');"],
	])("a script declaring the name itself is clean: %s", (source) => {
		expect(errorsOf(source)).toBe("");
	});

	/*
	 * Each line is what a script imported from Postman reaches for and the
	 * sandbox does not have. The declaration is `never`, so the call or member
	 * access that follows is the error.
	 */
	it.each([
		["_.map([1], function (n) { return n; });", 2339],
		["CryptoJS.MD5('x').toString();", 2339],
		["xml2Json(pm.response.text());", 2349],
		["moment().format();", 2349],
		["fetch('https://example.com');", 2349],
	])("%s is an error (TS%i)", (source, code) => {
		expect(errorsOf(source)).toContain(`TS${code}`);
	});

	/*
	 * The replacement is what a script author should write, so the same lines
	 * rewritten with it must stay clean - a declaration that made `pm.*` itself
	 * an error would pass every case above.
	 */
	it("is quiet on the replacements", () => {
		expect(
			errorsOf(
				[
					"const body = JSON.parse(pm.response.text());",
					"pm.test('fast', function () { pm.expect(pm.response.responseTime).to.be.below(200); });",
					"pm.environment.set('token', body.token);",
					"pm.execution.setNextRequest(null);",
				].join("\n")
			)
		).toBe("");
	});

	/*
	 * Postman's pre-pm.* globals run (#2577), each declared as the value it is,
	 * so the lines a legacy test script opens with draw nothing - and a member
	 * the value's type does not have is still an error.
	 */
	it("declares the legacy globals as the values they are", () => {
		expect(
			errorsOf(
				[
					"tests['Status code is 200'] = responseCode.code === 200;",
					"tests['ok'] = true;",
					"var jsonData = JSON.parse(responseBody);",
					"if (responseTime < 200) { }",
					"pm.environment.set('i', iteration + 1);",
					"const type = responseHeaders['Content-Type'];",
					"const base = environment.baseUrl + globals.region + data.name;",
					"const first = responseCookies[0].value;",
					"const url = request.url.toLowerCase();",
				].join("\n")
			)
		).toBe("");
		expect(errorsOf("responseTime.toUpperCase();")).toContain("TS2339");
	});

	/*
	 * The legacy `postman` methods run, as aliases of `pm` (#2577), so a script
	 * imported from Postman that calls them draws nothing - and a member the
	 * cookie they return does not have is still an error.
	 */
	it("declares the postman methods as the aliases they are", () => {
		expect(
			errorsOf(
				[
					"postman.setEnvironmentVariable('token', 'x');",
					"postman.setGlobalVariable('count', 1);",
					"const token = postman.getEnvironmentVariable('token');",
					"postman.clearEnvironmentVariables();",
					"postman.setNextRequest(null);",
					"postman.getResponseHeader('Content-Type').toLowerCase();",
					"postman.getResponseCookie('session').value.length;",
				].join("\n")
			)
		).toBe("");
		expect(errorsOf("postman.getResponseCookie('session').size;")).toContain("TS2339");
	});

	/*
	 * `pm.visualizer` is accepted and warns (#2577), so Postman's calls draw
	 * nothing - and the template is typed a string, where the engine refuses
	 * anything else.
	 */
	it("declares pm.visualizer as the calls Postman makes", () => {
		expect(
			errorsOf(
				[
					"pm.visualizer.set('<p>{{name}}</p>', { name: 'x' });",
					"pm.visualizer.set('<p></p>');",
					"pm.visualizer.set('<p></p>', pm.response.json(), { noEscape: true });",
					"pm.visualizer.clear();",
				].join("\n")
			)
		).toBe("");
		expect(errorsOf("pm.visualizer.set(42);")).toContain("TS2345");
	});
});

/*
 * The engine runs a script as the body of an async function (#2577), so a
 * top-level `await` is correct code and must draw nothing. As a module it is
 * accepted only under a `module` setting that allows one (TS1378 otherwise),
 * which is SCRIPT_COMPILER_OPTIONS' `module`.
 */
describe("a top-level await, as the editor reports it", () => {
	const compile = createCompiler(readFileSync(DECLARATIONS_PATH, "utf8"));
	const errorsOf = (source: string) => compile({ doc: "inline", line: 1, source }).join("\n");

	it("is clean", () => {
		expect(
			errorsOf(
				[
					"const code = await Promise.resolve(pm.response.code);",
					"pm.test('after await', () => pm.expect(code).to.equal(200));",
				].join("\n")
			)
		).toBe("");
	});

	it("still flags an await inside a function that is not async", () => {
		expect(errorsOf("function f() { await null; }")).toContain("TS1308");
	});
});
