/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `dependencies` and the main process's runtime imports are one set.
 *
 * electron-builder packs every package under `dependencies`, with its
 * transitive closure, into the asar, and nothing from `devDependencies`. The
 * renderer never reads from there - Vite bundles its packages into `dist/` -
 * so a renderer package under `dependencies` ships a copy the app never opens.
 * Before this test that was all of them: 14,479 files in the asar and a 3.8 MB
 * header that Electron parses on every launch and holds for the life of the
 * main process, where the main process reads from about 2,500 files. The other
 * direction is the launch that never shows a window: a package `electron/`
 * imports but `devDependencies` holds is there in development and absent from
 * the packaged app, where Node's loader fails with ERR_MODULE_NOT_FOUND.
 *
 * Every non-test source under `electron/` is emitted and reachable at runtime,
 * the dynamic imports included, so the scan reads them all rather than walking
 * from `main.ts`. `startup-import-graph.test.ts` is the walk, and asks a
 * different question: what runs before the window.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import path from "path";
import { fileURLToPath } from "url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
	readFileSync(path.join(electronDir, "..", "package.json"), "utf8")
) as { dependencies: Record<string, string> };

/** Every emitted `.ts` under electron/, recursively - what tsconfig.node.json compiles. */
function emittedSources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) return emittedSources(full);
		return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [full] : [];
	});
}

/** `{ type A, type B }` - erased by tsc. A default or namespace clause never is. */
function isAllTypeOnly(clause: string): boolean {
	const braced = clause.match(/^\{([\s\S]*)\}$/);
	if (!braced) return false;
	const names = braced[1]
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

/*
 * The clause grammar itself - `*`, `* as x`, a brace list, a default, or a
 * default with one of the last two - rather than "anything up to `from`". The
 * loose form reaches from an `import` line into prose a few lines down that
 * happens to say `from "absent"`, and names a package that is not one.
 */
const CLAUSE = String.raw`(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\*\s+as\s+\w+|\{[^}]*\}))?)`;
const WITH_CLAUSE = new RegExp(
	String.raw`(?:^|\n)\s*(?:import|export)\s+(type\s+)?(${CLAUSE})\s+from\s*["']([^"']+)["']`,
	"g"
);
const SIDE_EFFECT_ONLY = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRED = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

/**
 * The specifiers whose module the emitted code loads: static and side-effect
 * imports, `export ... from`, `import()` and the preload's `require()`. An
 * `import type` is erased by tsc and needs no package at runtime.
 */
function runtimeSpecifiers(source: string): string[] {
	const fromClauses = [...source.matchAll(WITH_CLAUSE)]
		.filter(([, typeKeyword, clause]) => !typeKeyword && !isAllTypeOnly(clause))
		.map(([, , , specifier]) => specifier);
	const rest = [SIDE_EFFECT_ONLY, DYNAMIC, REQUIRED].flatMap((pattern) =>
		[...source.matchAll(pattern)].map((m) => m[1])
	);
	return [...fromClauses, ...rest];
}

/** The package a bare specifier belongs to, or null for what needs no package. */
function packageOf(specifier: string): string | null {
	if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
	const [head, second] = specifier.split("/");
	const name = head.startsWith("@") ? `${head}/${second}` : head;
	// Electron is the runtime, not a package in the asar; Node's builtins likewise.
	if (name === "electron" || builtinModules.includes(name)) return null;
	return name;
}

describe("packaged dependencies", () => {
	const sources = emittedSources(electronDir);
	const packages = new Set<string>();
	for (const file of sources) {
		for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
			const name = packageOf(specifier);
			if (name) packages.add(name);
		}
	}

	it("scans a real tree", () => {
		expect(sources.length).toBeGreaterThan(30);
		// A package the main process genuinely needs - if this is missing the scan
		// matched nothing and the equality below is a comparison of two blanks.
		expect(packages).toContain("electron-store");
	});

	it("lists exactly the packages the main process imports under `dependencies`", () => {
		expect([...packages].sort()).toEqual(Object.keys(packageJson.dependencies).sort());
	});
});
