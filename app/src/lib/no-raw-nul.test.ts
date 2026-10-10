/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A raw NUL byte makes rg, grep and `file` classify a source file as binary, so
 * every grep-based sweep silently skips it (#1933). Spell the separator as the
 * escape `\u0000` instead.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(full);
		return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
	});
}

describe("source files hold no raw NUL byte", () => {
	const files = [
		...sources(path.join(appRoot, "src")),
		...sources(path.join(appRoot, "electron")),
	];

	it("scanned a non-empty tree", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("finds no U+0000 in any .ts or .tsx file", () => {
		const offenders = files.filter((f) => readFileSync(f).includes(0));
		expect(offenders.map((f) => path.relative(appRoot, f))).toEqual([]);
	});
});
