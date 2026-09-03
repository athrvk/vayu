/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Guards the composition in `monaco-setup.ts` (#1147): that file replaced
 * `import * as monaco from "monaco-editor"` (the package root, `editor.main`)
 * with explicit imports, because the root pulls in ~85 Monarch grammars, all
 * four language services and an LSP client - and two of those services, CSS
 * and HTML, reach their own workers through
 * `new Worker(new URL("css.worker.js", import.meta.url))` inside monaco's own
 * `workerManager`, so importing the root put 1.7MB of `css.worker` (1.0MB)
 * and `html.worker` (0.7MB) into every installer even though nothing here
 * ever constructs either.
 *
 * A source scan of `monaco-setup.ts` can prove which imports the file *asks
 * for*; it cannot prove what a bundler actually *emits* - that is a property
 * of the whole module graph those imports pull in, including the `?worker`
 * specifiers a plugin turns into separate entry points. So the last concern
 * below runs a real Vite build over the file's own import list, the same way
 * `fonts-woff2-only.test.ts` proves what `dist/` gets rather than reasoning
 * about the CSS that requests it.
 *
 * Five things are guarded here, each catching a different way the
 * composition could regress:
 *
 * 1. The two `as unknown as` casts in `monaco-setup.ts` are honest - the
 *    modules they cast really export, at runtime, what the cast promises and
 *    what the call sites (`variables-schema.ts`,
 *    `useScriptTypeDefinitions.ts`) read.
 * 2. Every language id the app can put in an editor model has a grammar
 *    imported. This is the mirror of this codebase's most repeated defect - a
 *    field written and never read: here it would be a language id asked for
 *    and never registered, which renders as silent plain text with nothing
 *    telling anyone it happened.
 * 3. Those languages are registered and actually tokenize, loading the app's
 *    real setup module and colorizing a snippet in each. This is the one that
 *    answers #1147's "highlighting verified working" criterion: 2 proves the
 *    file asks for a grammar, only this proves one arrived, since the failure
 *    mode is a silent fall back to plain text rather than a throw.
 * 4. The three things that pull `css.worker` / `html.worker` back in - the
 *    bare package root, and the CSS and HTML language *services* (not their
 *    Monarch grammars, which stay) - are absent from the file.
 * 5. The emitted worker set, from an actual build, is exactly what
 *    `getWorker` in `monaco-setup.ts` constructs: editor, json, ts.
 */

import { readFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { build } from "vite";

const MONACO_SETUP_PATH = path.resolve(__dirname, "monaco-setup.ts");
const RESPONSE_VIEWER_UTILS_PATH = path.resolve(
	__dirname,
	"../components/shared/response-viewer/utils.ts"
);
const APP_ROOT = path.resolve(__dirname, "../..");

const monacoSetupSource = readFileSync(MONACO_SETUP_PATH, "utf8");
const responseViewerUtilsSource = readFileSync(RESPONSE_VIEWER_UTILS_PATH, "utf8");

/**
 * Strips comments before any import-specifier scan below. Without this, the
 * doc comment at the top of `monaco-setup.ts` - which quotes
 * `import * as monaco from "monaco-editor"` verbatim, as the very thing the
 * file stopped doing - would itself satisfy a naive "does the source contain
 * this specifier" check, in both directions: a comment can fake a passing
 * import as easily as a real one can hide behind `//`.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const monacoSetupCode = stripComments(monacoSetupSource);

describe("the two casts in monaco-setup.ts are honest at runtime", () => {
	beforeAll(() => {
		// jsdom has no execCommand-based clipboard API; a contribution pulled in
		// transitively by both language modules below probes it at module-load
		// time and throws if it is missing. Guarded rather than unconditional so
		// a future jsdom that does implement it is left alone.
		if (typeof document.queryCommandSupported !== "function") {
			document.queryCommandSupported = () => false;
		}
	});

	/*
	 * monaco.contribution.js pulls in a large chunk of monaco's module graph on
	 * first import, which vitest has to transform cold. It is the only cost in
	 * this case - the four assertions below it are property reads.
	 *
	 * 6.85s measured on an idle Linux container (`vitest --reporter=verbose`,
	 * this case alone). The budget was 20s, call it 3x, and it was not enough:
	 * on `windows-latest` shard 1 it timed out twice in a row at 20s (#1219),
	 * where this file shares two cores with the rest of the shard *and* with
	 * the real `vite build` the last case in this file runs. Windows is the
	 * platform this repo already sizes differently for that reason - the test
	 * presets drop it to `-j4` with a `RESOURCE_LOCK` because concurrency there
	 * costs more than it returns.
	 *
	 * 45s is ~6.6x the measured cost, which clears the observed Windows
	 * overrun with room, and is still short enough that an import that truly
	 * hangs fails this file inside a minute instead of sitting on a runner.
	 * Raise it again only with a *measurement*, the way this line carries one:
	 * a number moved by reflex is how a wall-clock budget stops meaning
	 * anything (see the render-heavy note in `app/CLAUDE.md`).
	 */
	it(
		"json/monaco.contribution.js exports what the jsonDefaults cast promises",
		{ timeout: 45_000 },
		async () => {
			const jsonLanguage =
				await import("monaco-editor/esm/vs/language/json/monaco.contribution.js");
			// Declared as `export {}` (see monaco-setup.ts's own comment on the same
			// cast), so TS infers no overlap with the runtime shape being asserted
			// here - `unknown` first is the same escape monaco-setup.ts takes.
			const { jsonDefaults } = jsonLanguage as unknown as {
				jsonDefaults: { setDiagnosticsOptions: unknown; diagnosticsOptions: unknown };
			};
			// variables-schema.ts's applyVariablesSchema reads exactly these two
			// members off `monaco.json.jsonDefaults`.
			expect(typeof jsonDefaults.setDiagnosticsOptions).toBe("function");
			expect(typeof jsonDefaults.diagnosticsOptions).toBe("object");
		}
	);

	// Still 20s, and deliberately not raised with its neighbour: this one runs
	// warm. The json case above has already pulled monaco's shared editor graph
	// through the transform, so what is left here is the typescript language
	// module alone - 18ms in the same measured run. If these two are ever
	// reordered or split, this is the number that has to move.
	it(
		"typescript/monaco.contribution.js exports what the typescript cast promises",
		{ timeout: 20_000 },
		async () => {
			const typescriptLanguage =
				await import("monaco-editor/esm/vs/language/typescript/monaco.contribution.js");
			// Same `export {}` stub mismatch as the json case above.
			const mod = typescriptLanguage as unknown as {
				javascriptDefaults: {
					setCompilerOptions: unknown;
					getCompilerOptions: unknown;
					setDiagnosticsOptions: unknown;
					setModeConfiguration: unknown;
					addExtraLib: unknown;
				};
				ScriptTarget: Record<string, unknown>;
			};
			// useScriptTypeDefinitions.ts reads exactly these off
			// `monaco.typescript.javascriptDefaults`, plus `ScriptTarget.ESNext` for
			// the compiler target.
			for (const fn of [
				"setCompilerOptions",
				"getCompilerOptions",
				"setDiagnosticsOptions",
				"setModeConfiguration",
				"addExtraLib",
			] as const) {
				expect(typeof mod.javascriptDefaults[fn]).toBe("function");
			}
			expect(mod.ScriptTarget.ESNext).toBeDefined();
		}
	);
});

/**
 * The `languageMap` values inside `getMonacoLanguage`
 * (`response-viewer/utils.ts`), read from source rather than imported: the
 * function returns one string, not the map, so the map itself is only
 * visible to a scan.
 */
function extractLanguageMapValues(source: string): string[] {
	const mapMatch = source.match(
		/languageMap:\s*Record<BodyType,\s*string>\s*=\s*\{([\s\S]*?)\};/
	);
	if (!mapMatch) return [];
	return [...mapMatch[1].matchAll(/:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

const languageMapValues = extractLanguageMapValues(responseViewerUtilsSource);

describe("the response-viewer language map, scanned from source", () => {
	it("is non-empty and covers more than a token handful of languages", () => {
		// A scan that scanned nothing must fail loudly, not silently pass every
		// id check below by having no ids to check.
		expect(languageMapValues.length).toBeGreaterThan(0);
		expect(new Set(languageMapValues).size).toBeGreaterThan(4);
	});
});

/**
 * Ids the app can actually put in a Monaco model. `plaintext` is core (no
 * grammar module) and is dropped; `http` is dropped too, on the chance the
 * map ever grows one - it is registered by `registerHttpLanguage`
 * (`lib/http-language.ts`), not shipped by monaco, so it has no
 * `basic-languages` or `language` module to import.
 *
 * One id the response body can never be, but an editor still opens, is added
 * by hand:
 * - `graphql` - the `language="graphql"` prop in
 *   `RequestTabs/panels/body/GraphQLBody.tsx`. It is monaco's OWN basic
 *   language; `graphql/language-providers.ts`'s providers attach to that
 *   registered id rather than defining a new one.
 *
 * Checked by grepping `app/src` for `language=` / `defaultLanguage=` props
 * and `createModel(` calls: every other site passes `json`, `xml`,
 * `javascript`, `http` or `plaintext`, all already accounted for above.
 */
const EXTRA_LANGUAGE_IDS = ["graphql"];

const MONACO_LANGUAGE_IDS = [...new Set([...languageMapValues, ...EXTRA_LANGUAGE_IDS])].filter(
	(id) => id !== "plaintext" && id !== "http"
);

function hasGrammarImport(id: string): boolean {
	const basicLanguage = `monaco-editor/esm/vs/basic-languages/${id}/${id}.contribution.js`;
	const languageService = `monaco-editor/esm/vs/language/${id}/monaco.contribution.js`;
	return monacoSetupCode.includes(basicLanguage) || monacoSetupCode.includes(languageService);
}

describe("every language id the viewer or an editor can open has a grammar imported", () => {
	it.each(MONACO_LANGUAGE_IDS)("%s", (id) => {
		expect(hasGrammarImport(id)).toBe(true);
	});
});

/**
 * One snippet per id, keyed so that a new language cannot be added without
 * one: a missing key fails the coverage case below rather than quietly
 * skipping that language in the colorize case.
 */
const COLORIZE_SAMPLES: Record<string, string> = {
	css: "body { color: red; }",
	graphql: "query Q { field }",
	html: '<p class="x">hi</p>',
	javascript: "const a = 1;",
	json: '{ "a": 1 }',
	markdown: "# Title\n\n**bold**",
	xml: '<a b="c" />',
};

/** The distinct `mtkN` token classes monaco's colorizer put on a snippet. */
function tokenClasses(colorized: string): Set<string> {
	return new Set([...colorized.matchAll(/mtk\d+/g)].map((match) => match[0]));
}

/**
 * `json`'s tokenizer is not a Monarch grammar - it arrives from the JSON
 * language service's mode, which only comes up behind a live editor, so
 * `colorize` returns plain text for it headlessly. Measured against the OLD
 * package-root import at `ca9ee66`, before this change: json colorized to 1
 * class there too, while css=4, html=5, xml=4, markdown=2, javascript=3 and
 * graphql=4 - the same counts the composed entry produces now. So this is the
 * environment, identical either side of the change, not a language the
 * composition dropped. Registration is still asserted for it below, and
 * `jsonDefaults` is exercised for real in the first describe.
 */
const COLORIZE_EXEMPT = new Set(["json"]);

const COLORIZED_IDS = MONACO_LANGUAGE_IDS.filter((id) => !COLORIZE_EXEMPT.has(id));

/**
 * The check the import scan above cannot make. An id with no grammar
 * registered does not throw - Monaco silently falls back to plain text, which
 * is the whole failure mode being guarded, so the only way to tell the two
 * apart is to tokenize something and look at what came back.
 */
describe("the composed entry registers those languages and really tokenizes them", () => {
	it("has a colorize sample for every id the scan derived", () => {
		expect(MONACO_LANGUAGE_IDS.length).toBeGreaterThan(0);
		// Nothing may be exempted without still having a sample: the exemption
		// only skips the tokenizing assertion, never the coverage bookkeeping.
		for (const id of MONACO_LANGUAGE_IDS) {
			expect(COLORIZE_SAMPLES[id], `no colorize sample for "${id}"`).toBeTypeOf("string");
		}
		expect(COLORIZED_IDS.length).toBeGreaterThan(0);
	});

	// Loads the app's real setup module, which transforms monaco's editor core
	// plus the grammars cold. Measured 8-11s locally; 40s is roughly 4x that for
	// a slower or shared-core CI runner.
	it("colorizes each into more than one token class", { timeout: 40_000 }, async () => {
		const { monaco } = await import("./monaco-setup");

		const registered = new Set(monaco.languages.getLanguages().map((language) => language.id));
		for (const id of MONACO_LANGUAGE_IDS) {
			expect(registered, `"${id}" is not a registered language`).toContain(id);
		}

		// The control. `plaintext` has no tokenizer, so it is exactly what an id
		// with a dropped grammar degrades into - one class for the whole snippet.
		// Without this the assertion below could pass on a Monaco that had
		// stopped emitting `mtk` classes at all.
		const plain = await monaco.editor.colorize(COLORIZE_SAMPLES.css, "plaintext", {});
		expect(tokenClasses(plain).size).toBe(1);

		for (const id of COLORIZED_IDS) {
			const colorized = await monaco.editor.colorize(COLORIZE_SAMPLES[id], id, {});
			const classes = tokenClasses(colorized);
			expect(
				classes.size,
				`"${id}" colorized to ${classes.size} token class(es)`
			).toBeGreaterThan(1);
		}
	});
});

describe("the barrel and the two worker-pulling language services stay out", () => {
	it("never imports the bare monaco-editor package root", () => {
		// The bare root is `editor.main`: every Monarch grammar, all four
		// language services (css and html included) and an LSP client -
		// reintroducing it undoes the whole point of composing the entry by
		// hand. Matched as a whole specifier, not a substring, because every
		// `monaco-editor/esm/...` subpath import this file legitimately has
		// contains the string "monaco-editor" too.
		expect(monacoSetupCode).not.toMatch(/\bfrom\s+["']monaco-editor["']/);
		expect(monacoSetupCode).not.toMatch(/\bimport\s+["']monaco-editor["']/);
	});

	it("never imports the css or html language service (their grammars are fine)", () => {
		// These two - not the `basic-languages/css` and `basic-languages/html`
		// Monarch grammars, which stay imported for syntax highlighting - are
		// what call `new Worker(new URL("css.worker.js", import.meta.url))` /
		// `html.worker.js` inside monaco's own `workerManager`.
		expect(monacoSetupCode).not.toContain("monaco-editor/esm/vs/language/css/");
		expect(monacoSetupCode).not.toContain("monaco-editor/esm/vs/language/html/");
	});
});

describe("the emitted worker set, from a real build", () => {
	/**
	 * Every `monaco-editor/...` import specifier `monaco-setup.ts` actually
	 * has, extracted from source so this fixture can never drift from the real
	 * file - a specifier added or removed there is picked up here without
	 * either file needing to change.
	 */
	function extractMonacoSpecifiers(source: string): string[] {
		return [...source.matchAll(/["'](monaco-editor\/[^"']+)["']/g)].map((m) => m[1]);
	}

	/**
	 * Re-issues the extracted specifiers as side-effecting imports. The
	 * `?worker` ones keep their default import (bound to a discarded name) so
	 * Vite's worker plugin still treats them as worker entry points - a bare
	 * `import "x?worker"` with no binding is not what `monaco-setup.ts` writes
	 * and is not guaranteed to trigger the same handling.
	 */
	function buildFixtureEntry(specifiers: string[]): string {
		let workerIndex = 0;
		const lines = specifiers.map((specifier) => {
			if (!specifier.includes("?worker")) return `import ${JSON.stringify(specifier)};`;
			const name = `Worker${workerIndex++}`;
			return `import ${name} from ${JSON.stringify(specifier)};\nvoid ${name};`;
		});
		return `${lines.join("\n")}\n`;
	}

	const specifiers = extractMonacoSpecifiers(monacoSetupCode);

	// Measured 5.6-7.4s locally for this exact fixture (13 specifiers, ~1055
	// modules transformed). 30s is roughly 4x the upper end, for a slower or
	// shared-core CI runner.
	it("emits exactly editor/json/ts workers, never css or html", { timeout: 30_000 }, async () => {
		// Guards everything below against a fixture that had no imports to
		// build, which would otherwise pass this test by building nothing.
		expect(specifiers.length).toBeGreaterThan(0);

		const root = mkdtempSync(path.join(tmpdir(), "vayu-monaco-workers-"));
		const entry = path.join(root, "entry.ts");
		writeFileSync(entry, buildFixtureEntry(specifiers));
		const outDir = path.join(root, "out");

		// No app plugins, deliberately - same reason as fonts-woff2-only.test.ts:
		// this proves what Vite's OWN worker plugin does with these specifiers,
		// not what the app's larger pipeline happens to do to them today. The
		// fixture lives outside the app, so `monaco-editor` is aliased straight
		// at the app's own installed copy rather than copied around.
		await build({
			root,
			logLevel: "silent",
			resolve: {
				alias: [
					{
						find: "monaco-editor",
						replacement: path.join(APP_ROOT, "node_modules/monaco-editor"),
					},
				],
			},
			build: { outDir, rolldownOptions: { input: entry } },
		});

		const assets = path.join(outDir, "assets");
		const files = readdirSync(assets);
		expect(files.length).toBeGreaterThan(0);

		const workerFiles = files.filter((f) => f.includes(".worker"));
		const workerStems = new Set(workerFiles.map((f) => f.split(".worker")[0]));

		expect(workerFiles.some((f) => f.startsWith("css.worker"))).toBe(false);
		expect(workerFiles.some((f) => f.startsWith("html.worker"))).toBe(false);
		expect(workerStems).toEqual(new Set(["editor", "json", "ts"]));
	});
});
