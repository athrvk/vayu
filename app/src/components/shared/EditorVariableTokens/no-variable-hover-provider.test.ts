/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No Monaco hover provider answers for a `{{token}}` any more (issue #1320).
 *
 * The card over a token is the app's own tooltip, drawn per editor. A hover
 * provider is the other thing, and it is registered per *language*: the `json`
 * provider answering for a request body is the same object Monaco asks about a
 * response body, which is why the old one needed a registry of marked models
 * to tell them apart. Re-registering one - for `{{` completion's languages, or
 * as a "quick" second reading of a token - brings back both the registry and
 * VS Code's palette over Vayu's, and no behavioural test would notice: the
 * app's tooltip would keep passing while Monaco drew its own card underneath.
 *
 * So the rule is enumerable rather than impossible: every `registerHoverProvider`
 * in `src` is read, and the one language that legitimately has a provider - a
 * GraphQL schema hover, which answers about the schema and not about variables
 * - is named here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** `app/src` - this file lives in `src/components/shared/EditorVariableTokens`. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The one file that may register a hover provider, and what it answers about. */
const ALLOWED = join("lib", "graphql", "language-providers.ts");

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
	}
	return out;
}

const files = sourceFiles(SRC);

describe("the variable hover is not a Monaco hover provider", () => {
	it("found the sources to scan", () => {
		// A walk that stopped matching would make the case below vacuous - this
		// repo has had a guard pass for weeks while reading an empty string.
		expect(files.length).toBeGreaterThan(200);
	});

	it("registers a hover provider for the GraphQL schema and nothing else", () => {
		const registrars = files
			.filter((file) => readFileSync(file, "utf8").includes("registerHoverProvider"))
			.map((file) => relative(SRC, file).split(sep).join(sep));
		// Mutation check: register one for `json` again - the shape issue #1320
		// deleted - and this names the file that did it.
		expect(registrars).toEqual([ALLOWED]);
	});
});
