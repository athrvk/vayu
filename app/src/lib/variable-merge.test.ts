/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { mergeVariableChanges, findVariableConflicts, type VariableMap } from "./variable-merge";
import type { VariableValue } from "@/types";

/** Resolves relative to this test file, independent of the working directory. */
function readSource(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");
}

function v(value: string, overrides: Partial<VariableValue> = {}): VariableValue {
	return { value, enabled: true, secret: false, type: "string", ...overrides };
}

describe("mergeVariableChanges", () => {
	it("carries an untouched key through from the fresh map", () => {
		const fresh: VariableMap = { host: v("example.com"), token: v("abc") };
		const merged = mergeVariableChanges(fresh, { token: v("xyz") });

		expect(merged.host).toEqual(v("example.com"));
		expect(merged.token).toEqual(v("xyz"));
	});

	it("adds a key the change names that the fresh map does not have", () => {
		const merged = mergeVariableChanges({}, { newKey: v("1") });
		expect(merged.newKey).toEqual(v("1"));
	});

	it("deletes a key marked null, even one only the fresh map holds", () => {
		const fresh: VariableMap = { host: v("example.com") };
		const merged = mergeVariableChanges(fresh, { host: null });
		expect(merged.host).toBeUndefined();
	});

	it("does not mutate the fresh map it was given", () => {
		const fresh: VariableMap = { host: v("example.com") };
		mergeVariableChanges(fresh, { host: v("changed") });
		expect(fresh.host).toEqual(v("example.com"));
	});
});

describe("findVariableConflicts", () => {
	const baseline: VariableMap = { host: v("example.com") };

	it("does not consider a key the change never touched", () => {
		// Something else moved "host" in the fresh map, but this write's
		// changes are about a different key entirely - not this write's problem.
		const fresh: VariableMap = { host: v("theirs") };
		const conflicts = findVariableConflicts(baseline, { other: v("mine") }, fresh);
		expect(conflicts).toEqual([]);
	});

	it("reports nothing when only this write moved the key", () => {
		const conflicts = findVariableConflicts(baseline, { host: v("mine") }, baseline);
		expect(conflicts).toEqual([]);
	});

	it("reports nothing when both sides land on the same value", () => {
		const fresh: VariableMap = { host: v("same") };
		const conflicts = findVariableConflicts(baseline, { host: v("same") }, fresh);
		expect(conflicts).toEqual([]);
	});

	it("reports a conflict when both sides move the key to different values", () => {
		const fresh: VariableMap = { host: v("theirs") };
		const conflicts = findVariableConflicts(baseline, { host: v("mine") }, fresh);
		expect(conflicts).toEqual([{ key: "host", mine: v("mine"), theirs: v("theirs") }]);
	});

	it("reports a conflict between a deletion and a concurrent update", () => {
		const fresh: VariableMap = { host: v("theirs") };
		const conflicts = findVariableConflicts(baseline, { host: null }, fresh);
		expect(conflicts).toEqual([{ key: "host", mine: null, theirs: v("theirs") }]);
	});
});

describe("the two variable-map writers share this merge", () => {
	// The whole point of pulling the merge out (#1439): the context bar's
	// single-key commit and the Variables tab's multi-row save read fresh and
	// merge the same way instead of each re-deriving it. A hand-rolled copy in
	// either file would not fail any test above - it would just quietly stop
	// being the primitive this module documents. Guard the import itself.
	it("useVariableCommit imports mergeVariableChanges from here", () => {
		const source = readSource("../components/layout/context-bar/variable-commit.ts");
		expect(source).toMatch(/mergeVariableChanges/);
		expect(source).toMatch(/from ["']@\/lib\/variable-merge["']/);
	});

	it("VariableTableEditor imports mergeVariableChanges from here", () => {
		const source = readSource("../modules/variables/main/VariableTableEditor.tsx");
		expect(source).toMatch(/mergeVariableChanges/);
		expect(source).toMatch(/from ["']@\/lib\/variable-merge["']/);
	});
});
