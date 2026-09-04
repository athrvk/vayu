/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's spellchecker is off, in one place (issue #1355).
 *
 * Electron enables Chromium's spellchecker by default, so every editable field
 * in the request builder - URL bar, header keys and values, query parameters,
 * variable values - drew red underlines under things that are not prose, while
 * Monaco (which owns its own text area) did not. On Windows and Linux the
 * checker also fetches Hunspell dictionaries from a Google CDN the first time
 * it runs, which is a network request the app never disclosed.
 *
 * `main.ts` creates the window at import time, so the option can only be read -
 * the characterization approach `startup-order.test.ts` and
 * `renderer-recovery.test.ts` take to main.ts's own wiring. The second case is
 * the other half of "one place": with the window option set, a per-field
 * `spellCheck={false}` is a dead attribute that suggests the default is still
 * on, so none may come back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.ts"), "utf8");

/** The `webPreferences` object literal in `createWindow`, braces included. */
function webPreferencesBlock(): string {
	const start = main.indexOf("\t\twebPreferences: {");
	expect(start).toBeGreaterThan(-1);

	// The literal holds no nested braces today; `\n\t\t},` is its own closer at
	// the option's indent, which a nested one could not match.
	const end = main.indexOf("\n\t\t},", start);
	expect(end).toBeGreaterThan(start);

	return main.slice(start, end);
}

describe("the renderer window", () => {
	it("disables the spellchecker in webPreferences", () => {
		expect(webPreferencesBlock()).toContain("spellcheck: false");
	});

	it("keeps the setting on the window rather than a session override", () => {
		// `setSpellCheckerDictionaryDownloadURL` would keep the checker on and
		// only move the download; the app has no field where a spellchecked word
		// helps, so there is nothing to redirect.
		expect(main).not.toContain("setSpellCheckerDictionaryDownloadURL");
		expect(main).not.toContain("setSpellCheckerLanguages");
	});
});

const RENDERER_SOURCES = join(here, "..", "src");

function rendererFiles(): string[] {
	return globSync("**/*.{ts,tsx}", { cwd: RENDERER_SOURCES }).map((f) =>
		join(RENDERER_SOURCES, f)
	);
}

describe("the renderer's own fields", () => {
	it("found the files to scan", () => {
		// A glob that stopped matching would make the next case vacuous.
		expect(rendererFiles().length).toBeGreaterThan(500);
	});

	it("carries no per-field spellCheck attribute", () => {
		const offenders = rendererFiles()
			.filter((file) => /spellCheck\s*=/.test(readFileSync(file, "utf8")))
			.map((file) => file.slice(RENDERER_SOURCES.length + 1));

		expect(offenders).toEqual([]);
	});
});
