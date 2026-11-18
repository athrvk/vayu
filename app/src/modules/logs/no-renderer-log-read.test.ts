/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer reads no log file (#3635). The log files are the user's data and
 * hold what the app logged about it, so the only way to them is `electronAPI.logs`,
 * which the main process answers from its own listing of `<data-dir>/logs/`
 * (`electron/log-reader.ts`) and never from a path the renderer names. A renderer
 * source that could open a file itself would be a second way in that none of
 * that covers.
 *
 * Source-scanned: no non-test file under `src` names `readFile`, `createReadStream`
 * or a `fs` module. The renderer has no `fs` to import under Electron's sandbox,
 * so this fails on the intent, before a bundler is asked what it would do.
 *
 * Mutation check: add `import { readFile } from "node:fs/promises"` to
 * `LogsTab.tsx` and the case below reds.
 */

import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The code generators write `readFile` into the snippets they hand a user (a
 * request body from a file, in the generated Node code); it is text the renderer
 * emits, never a call it makes.
 */
const EMITS_CODE_SAMPLES = "services/codegen/";

const sources = globSync("**/*.{ts,tsx}", { cwd: srcRoot })
	.map((file) => file.split(sep).join("/"))
	.filter((file) => !/\.(test|testkit)\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
	.filter((file) => !file.startsWith(EMITS_CODE_SAMPLES))
	.map((file) => ({ file, code: stripComments(readFileSync(join(srcRoot, file), "utf8")) }));

const FILE_READ = /\b(?:readFile\w*|createReadStream)\b|from\s+["'](?:node:)?fs(?:\/promises)?["']/;

describe("no renderer source reads a log file", () => {
	it("scanned the renderer's sources, the Logs module among them", () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(
			sources.filter(({ file }) => file.startsWith("modules/logs/")).length
		).toBeGreaterThan(3);
	});

	it("recognises each way to read a file", () => {
		expect(FILE_READ.test('import { readFile } from "node:fs/promises";')).toBe(true);
		expect(FILE_READ.test("const text = fs.readFileSync(path);")).toBe(true);
		expect(FILE_READ.test("fs.createReadStream(path)")).toBe(true);
		expect(FILE_READ.test('import fs from "fs";')).toBe(true);
		expect(FILE_READ.test("window.electronAPI.logs.read(request)")).toBe(false);
	});

	it("finds none", () => {
		const offenders = sources
			.filter(({ code }) => FILE_READ.test(code))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});
});
