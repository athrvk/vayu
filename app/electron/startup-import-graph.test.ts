/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the main process evaluates before it does anything.
 *
 * The main process is unbundled: `electron:compile` is plain `tsc`, so
 * `dist-electron/` is one emitted file per source module and Node's ESM loader
 * walks the static import graph from `main.ts` file by file, evaluating every
 * module in it, before `app.whenReady` ever fires. Nothing else gates that -
 * a preference read inside a function cannot stop work the loader already did
 * on the way to calling it. So the graph below *is* the startup cost, and the
 * only way to not pay for a subsystem is to not be in it.
 *
 * The MCP stack is the case that made this a test (#1145): the barrel pulled
 * the MCP SDK, zod and a 7,300-line tool registry with 67 schemas built at
 * module scope, ~250-300ms of serial evaluation ahead of the window, on every
 * launch - including launches with MCP switched off, because `main.ts` reached
 * through that barrel for the very preference that decides whether to start it.
 *
 * Scanned rather than executed for the usual reason: `main.ts` creates windows
 * and starts the engine at import time, so it cannot be imported. The counts in
 * the first case exist so a broken walk or a regex that stopped matching fails
 * loudly instead of passing over an empty graph.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(electronDir, "main.ts");

/**
 * Specifiers whose module the ESM loader actually evaluates.
 *
 * `import type` / `export type` are erased by tsc, and so is a brace list whose
 * every member carries an inline `type` modifier - none of those reach the
 * loader, so none of them cost anything at startup.
 */
function eagerSpecifiers(source: string): string[] {
	const withClause =
		/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
	const sideEffectOnly = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

	const specifiers = [...source.matchAll(withClause)]
		.filter(([, typeKeyword, clause]) => !typeKeyword && !isAllTypeOnly(clause))
		.map(([, , , specifier]) => specifier);

	return [...specifiers, ...[...source.matchAll(sideEffectOnly)].map((m) => m[1])];
}

/** `{ type A, type B }` - erased. A default or namespace clause never is. */
function isAllTypeOnly(clause: string): boolean {
	const braced = clause.match(/^\{([\s\S]*)\}$/);
	if (!braced) return false;
	const names = braced[1]
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

/** A relative specifier back to the `.ts` it was emitted from, or null for a package. */
function resolveSource(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const source = path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, ".ts");
	return existsSync(source) ? source : null;
}

/** Every module the loader evaluates on the way to running `main.ts`. */
function eagerGraph(entryFile: string): { files: Set<string>; packages: Set<string> } {
	const files = new Set<string>();
	const packages = new Set<string>();
	const queue = [entryFile];

	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (files.has(file)) continue;
		files.add(file);

		for (const specifier of eagerSpecifiers(readFileSync(file, "utf8"))) {
			const source = resolveSource(file, specifier);
			if (source) queue.push(source);
			else if (!specifier.startsWith(".")) packages.add(specifier);
		}
	}
	return { files, packages };
}

describe("main process startup import graph", () => {
	const { files, packages } = eagerGraph(entry);
	const relative = new Set([...files].map((f) => path.relative(electronDir, f)));

	it("walks a real graph", () => {
		expect(relative.size).toBeGreaterThan(15);
		expect(packages.size).toBeGreaterThan(3);
		// A module main.ts genuinely does need at launch - if this is missing the
		// walk resolved nothing and every exclusion below is vacuous.
		expect(relative).toContain("sidecar.ts");
	});

	it("does not evaluate the MCP SDK or the tool registry", () => {
		const sdk = [...packages].filter((p) => p.startsWith("@modelcontextprotocol/sdk"));
		expect(sdk).toEqual([]);

		const mcpModules = [...relative].filter((f) => f.startsWith(`mcp${path.sep}`));
		expect(mcpModules.sort()).toEqual(
			[
				path.join("mcp", "config.ts"),
				path.join("mcp", "connect.ts"),
				path.join("mcp", "store.ts"),
			].sort()
		);
	});

	/*
	 * The exclusion above is only worth anything if the cheap half is still
	 * reached - a lazy load that also stopped reading the preference would pass
	 * it while breaking the feature.
	 */
	it("still evaluates the modules the startup gate and Settings IPC need", () => {
		expect(relative).toContain(path.join("mcp", "store.ts"));
		expect(relative).toContain(path.join("mcp", "config.ts"));
		expect(relative).toContain(path.join("mcp", "connect.ts"));
	});

	it("reads the enabled preference before loading the MCP barrel", () => {
		const main = readFileSync(entry, "utf8");
		const start = main.indexOf("async function startMcp()");
		const end = main.indexOf("async function stopMcp()", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = main.slice(start, end);

		const gate = body.indexOf("loadMcpEnabled()");
		const load = body.indexOf("await loadMcp()");
		expect(gate).toBeGreaterThan(-1);
		expect(load).toBeGreaterThan(-1);
		expect(gate).toBeLessThan(load);
	});
});
