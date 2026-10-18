/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's kind has one name in the UI, `RUN_TYPE_NAME` (docs/ux-writing.md). A
 * second table ("load test" / "request" / "collection") once leaked into
 * accessible names and the palette, so the guard below fails on any second
 * spelling rather than on the one that happened to be found.
 *
 * Mutation check: re-add a `RUN_KIND_LABEL` export to `types.ts`, or a
 * `run.type === "load" ? "load test" : "request"` ternary to any component, and
 * the guards fail.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";
import * as historyTypes from "./types";
import { RUN_TYPE_NAME } from "./types";

describe("RUN_TYPE_NAME", () => {
	it("names each run type in sentence case, never by its wire value", () => {
		expect(RUN_TYPE_NAME).toEqual({
			design: "Send",
			scenario: "Collection run",
			load: "Load test",
		});
	});

	it("is the only run-kind table the module exports", () => {
		expect(Object.keys(historyTypes)).not.toContain("RUN_KIND_LABEL");
	});
});

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

const sources = walk(srcRoot)
	.filter((file) => !/\.test\.tsx?$|\.testkit\.ts$/.test(file))
	.map((file) => ({
		path: relative(srcRoot, file).split("\\").join("/"),
		code: stripComments(readFileSync(file, "utf8")),
	}));

/** `type === "load" ? "..."`: a kind-to-words choice made inline. */
const KIND_TERNARY = /\btype\s*===\s*["'](?:load|design|scenario)["']\s*\?\s*["'`]/g;

/** `load: "..."`, `"design": '...'`: a table keyed by run type with words as values. */
const KIND_TABLE_ENTRY = /["']?\b(?:load|design|scenario)\b["']?\s*:\s*["'`]/g;

/** What a hand-written "scenario load run" label said before the name was one table. */
const SCENARIO_LOAD_RUN = /scenario load run/i;

/** Source files, relative to `src/`, allowed a kind-keyed string table, and how many entries. */
const KIND_TABLES: Record<string, number> = {
	// The table itself.
	"modules/history/types.ts": 3,
	// Agent vocabulary, not UI copy: `Vayu run "x" (run_1) - collection run, ...` is
	// pasted into an agent's context and must stay in the words `agent-reference.test.ts` pins.
	"lib/agent-reference.ts": 3,
};

/** Source files allowed a kind ternary that yields words, and why. */
const KIND_TERNARIES: Record<string, string> = {
	// The strategy line's value: a send has no load mode, so it says "Single send".
	// That names a mode, not the run's kind.
	"components/layout/context-bar/RunConfigSection.tsx": "run mode",
};

function count(code: string, pattern: RegExp): number {
	return [...code.matchAll(pattern)].length;
}

describe("one name per run kind", () => {
	it("scanned the app's source, not an empty tree", () => {
		expect(sources.length).toBeGreaterThan(200);
		expect(sources.every((source) => source.code.length > 0)).toBe(true);
	});

	it("keeps run kind words out of inline ternaries", () => {
		const offenders = sources
			.filter(({ path }) => !(path in KIND_TERNARIES))
			.filter(({ code }) => count(code, KIND_TERNARY) > 0)
			.map(({ path }) => path);
		expect(offenders).toEqual([]);
	});

	it("keeps run kind words out of a second table", () => {
		const offenders = sources
			.filter(({ path, code }) => count(code, KIND_TABLE_ENTRY) !== (KIND_TABLES[path] ?? 0))
			.map(({ path }) => path);
		expect(offenders).toEqual([]);
	});

	it("does not call a load test over a collection a 'scenario load run'", () => {
		const offenders = sources
			.filter(({ code }) => SCENARIO_LOAD_RUN.test(code))
			.map(({ path }) => path);
		expect(offenders).toEqual([]);
	});

	it("only allowlists files that still need it", () => {
		const paths = new Set(sources.map(({ path }) => path));
		for (const path of [...Object.keys(KIND_TABLES), ...Object.keys(KIND_TERNARIES)]) {
			expect(paths.has(path), path).toBe(true);
		}
		const ternaryFile = sources.find(({ path }) => path in KIND_TERNARIES);
		expect(ternaryFile && count(ternaryFile.code, KIND_TERNARY)).toBeGreaterThan(0);
	});
});
