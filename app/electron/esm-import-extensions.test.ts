/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every relative import in the emitted main process must carry its extension.
 *
 * The package is `"type": "module"`, so Node runs `dist-electron/*.js` through
 * the ESM loader, which does not resolve an extensionless specifier. `tsc`
 * copies the specifier through untouched and cannot object: tsconfig.node.json
 * is on `moduleResolution: "bundler"`, which promises a bundler will resolve
 * this - a promise nothing keeps here, because Electron runs the output
 * directly. So `import { x } from "./y"` type-checks, compiles, and then throws
 * ERR_MODULE_NOT_FOUND on launch. That is exactly how `oauth.ts` shipped an
 * import of `./oauth-window` that killed the app during load.
 *
 * `moduleResolution: "nodenext"` is the compiler's own version of this check
 * (TS2835) and is the obvious fix, but it also reclassifies `preload.ts` as
 * ESM and stamps `export {}` on it, which breaks the preload - see the comment
 * in tsconfig.node.json. Until the preload becomes `preload.cts`, this test is
 * the check.
 *
 * Test files are excluded for the same reason tsconfig.node.json excludes them:
 * they are never emitted, and vitest resolves their specifiers off the TypeScript
 * sources.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));

/** Every emitted `.ts` under electron/, recursively. */
function emittedSources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) return emittedSources(full);
		if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
		return [full];
	});
}

/**
 * Relative specifiers in `import`/`export ... from` and dynamic `import()`.
 * A `require()` is deliberately not matched - preload.ts is CommonJS by
 * necessity and the CJS resolver does fill in an extension.
 */
function relativeSpecifiers(source: string): string[] {
	const patterns = [
		/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*["'](\.[^"']*)["']/g,
		/(?:^|\n)\s*import\s*["'](\.[^"']*)["']/g,
		/\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g,
	];
	return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

describe("emitted main process imports", () => {
	const files = emittedSources(electronDir);

	// A scan that reads nothing passes silently. Both counts are asserted so a
	// broken walk or a regex that stops matching fails loudly instead.
	it("scans the main process sources", () => {
		expect(files.length).toBeGreaterThan(10);
		const total = files.reduce(
			(n, f) => n + relativeSpecifiers(readFileSync(f, "utf8")).length,
			0
		);
		expect(total).toBeGreaterThan(20);
	});

	it.each(files.map((f) => path.relative(electronDir, f)))(
		"%s imports relatively with an explicit extension",
		(relative) => {
			const specifiers = relativeSpecifiers(
				readFileSync(path.join(electronDir, relative), "utf8")
			);
			const extensionless = specifiers.filter(
				(s) => !s.endsWith(".js") && !s.endsWith(".json")
			);
			expect(extensionless).toEqual([]);
		}
	);
});
