/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every window Vayu opens has the spellchecker off (issue #1355).
 *
 * Electron enables Chromium's spellchecker by default, so every editable field
 * in the request builder - URL bar, header keys and values, query parameters,
 * variable values - drew red underlines under things that are not prose, while
 * Monaco (which owns its own text area) did not. On Windows and Linux the
 * checker also fetches Hunspell dictionaries from a Google CDN the first time
 * it runs, which is a network request the app never disclosed.
 *
 * The guard is written over *every* `new BrowserWindow` in `app/electron`
 * rather than over the main window's options alone, because the app has two -
 * the shell and the OAuth sign-in window - and the second one was missed on the
 * first pass. A third would be missed the same way; this way it fails instead.
 * The windows are constructed at import time, so their options can only be read
 * - the characterization approach `startup-order.test.ts` and
 * `renderer-recovery.test.ts` take to main.ts's own wiring.
 *
 * The other half of "off in one place" is the renderer: with the window option
 * set, a per-field `spellCheck={false}` is a dead attribute that suggests the
 * default is still on, so none may come back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The option object of every `new BrowserWindow({...})` in the main process,
 * sliced by counting braces so the guard survives a reindent - it reads what
 * the constructor is passed, not how the file happens to be formatted.
 */
function browserWindowOptions(): { file: string; source: string }[] {
	const blocks: { file: string; source: string }[] = [];

	for (const name of globSync("*.ts", { cwd: here }).filter((f) => !f.endsWith(".test.ts"))) {
		const source = readFileSync(join(here, name), "utf8");
		const opener = "new BrowserWindow({";

		for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
			let depth = 0;
			let cursor = at + opener.length - 1;

			do {
				if (source[cursor] === "{") depth++;
				if (source[cursor] === "}") depth--;
				cursor++;
			} while (depth > 0 && cursor < source.length);

			expect(depth, `unbalanced BrowserWindow options in ${name}`).toBe(0);
			blocks.push({ file: name, source: source.slice(at, cursor) });
		}
	}

	return blocks;
}

describe("every window the app opens", () => {
	it("found the windows to scan", () => {
		// Two today: the shell in main.ts and the OAuth window in oauth.ts. A
		// scan that stopped matching would make the next case vacuous.
		expect(
			browserWindowOptions()
				.map((b) => b.file)
				.sort()
		).toEqual(["main.ts", "oauth.ts"]);
	});

	it("disables the spellchecker in its webPreferences", () => {
		const offenders = browserWindowOptions()
			.filter((b) => !b.source.includes("spellcheck: false"))
			.map((b) => b.file);

		expect(offenders).toEqual([]);
	});

	it("keeps the setting on the window rather than a session override", () => {
		// `setSpellCheckerDictionaryDownloadURL` would keep the checker on and
		// only move the download; the app has no field where a spellchecked word
		// helps, so there is nothing to redirect.
		const main = readFileSync(join(here, "main.ts"), "utf8");

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
