/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Two guards on the two-compiler arrangement (#467 Stage 1), both locking a
 * mistake that produces no error at the moment it is made.
 *
 * **Every tsconfig states `strict` rather than inheriting it.** The option's
 * default is not stable across compilers: TypeScript 5 defaults it to `false`
 * and TypeScript 7 defaults it to `true`. `tsconfig.node.json` left it unset,
 * so the whole Electron main process was checked non-strictly by 5.x and
 * strictly by 7.x - the sole divergence in a full two-compiler diff of this
 * tree, and one this repo did not know it had, since `app/CLAUDE.md` states
 * strict TypeScript as the convention and `electron/` is written as though it
 * held. An unset `strict` is therefore not a default being accepted; it is a
 * different language per compiler, which is precisely what a repo running two
 * of them cannot afford. A config may inherit the value through `extends`, as
 * long as something in its chain says it out loud.
 *
 * **No script invokes a bare `tsc`.** Installing TypeScript twice - once as
 * `typescript`, once aliased as `tsc7` - puts two packages in the tree that
 * both claim the `tsc` bin, and only one of them wins `node_modules/.bin/tsc`.
 * The winner today is `tsc7`, which means a bare `tsc` in a script silently
 * moves to the new compiler: `electron:compile` is the *emit* for the main
 * process and `build.py` runs it, so the bin race decides what ships. Which
 * package wins is pnpm's business, not ours, so every invocation names its
 * compiler by path instead of asking the race.
 *
 * At Stage 2 the alias goes away and the second guard's reason goes with it -
 * delete it then, deliberately, rather than letting it rot.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The tsconfigs `pnpm type-check` drives, one per project. */
const TSCONFIGS = ["tsconfig.json", "tsconfig.node.json", "tsconfig.electron-test.json"];

/**
 * Strips comments from JSONC without touching comment-like text inside string
 * literals. `JSON.parse` cannot read these files - all three carry the block
 * comments that hold their rationale.
 */
function stripJsonComments(source: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		const next = source[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && next === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			// A backslash escapes the next character, including a quote.
			if (c === "\\") {
				out += c + (next ?? "");
				i++;
				continue;
			}
			if (c === '"') inString = false;
			out += c;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && next === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out;
}

interface TsConfig {
	extends?: string;
	compilerOptions?: { strict?: boolean };
}

function readTsConfig(relative: string): TsConfig {
	const raw = readFileSync(path.join(appDir, relative), "utf8");
	return JSON.parse(stripJsonComments(raw)) as TsConfig;
}

/**
 * Walks `extends` from `relative` upward, returning the first config in the
 * chain that states `strict` - or null if none of them does.
 */
function resolveStrict(relative: string): { declaredIn: string; value: boolean } | null {
	let current: string | undefined = relative;
	const seen = new Set<string>();
	while (current && !seen.has(current)) {
		seen.add(current);
		const config: TsConfig = readTsConfig(current);
		const strict = config.compilerOptions?.strict;
		if (strict !== undefined) return { declaredIn: current, value: strict };
		current = config.extends
			? path.normalize(path.join(path.dirname(current), config.extends))
			: undefined;
	}
	return null;
}

describe("tsconfig strict is stated, not inherited from a compiler default", () => {
	it("scans every project config", () => {
		expect(TSCONFIGS.length).toBe(3);
		for (const file of TSCONFIGS) {
			expect(readFileSync(path.join(appDir, file), "utf8").length).toBeGreaterThan(0);
		}
	});

	it.each(TSCONFIGS)("%s resolves strict to an explicit true", (file) => {
		const resolved = resolveStrict(file);
		expect(
			resolved,
			`${file} never states "strict" and does not extend a config that does, so its ` +
				`meaning is whichever default the compiler running it happens to carry ` +
				`(false on TypeScript 5, true on TypeScript 7).`
		).not.toBeNull();
		expect(resolved?.value).toBe(true);
	});
});

describe("package.json scripts name their TypeScript compiler", () => {
	const scripts = (
		JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		}
	).scripts;

	/** `tsc` not reached through an explicit `.../bin/tsc` path. */
	const BARE_TSC = /(?<!bin\/)\btsc\b/;

	it("finds scripts that invoke tsc at all", () => {
		const invoking = Object.values(scripts).filter((command) => /\btsc\b/.test(command));
		// build, electron:compile, electron:watch, type-check - the scan is
		// worthless if a refactor empties it and it keeps passing.
		expect(invoking.length).toBeGreaterThanOrEqual(4);
	});

	it.each(Object.entries(scripts))("%s", (_name, command) => {
		expect(
			BARE_TSC.test(command),
			`Resolves through node_modules/.bin/tsc, which two installed packages ` +
				`(typescript, tsc7) both claim - name the compiler by path instead: ` +
				`"${command}"`
		).toBe(false);
	});
});
