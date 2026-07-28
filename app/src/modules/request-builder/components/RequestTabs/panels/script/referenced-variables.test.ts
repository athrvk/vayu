/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which names a script mentions. This was inline in both script panels, in
 * duplicate, and reachable only by rendering a panel and reading its chips -
 * so the edges below were never covered by anything.
 */

import { describe, it, expect } from "vitest";
import { referencedVariables } from "./referenced-variables";

describe("the pm API", () => {
	it.each(["environment", "globals", "collectionVariables"])("reads pm.%s.get", (bucket) => {
		expect(referencedVariables(`pm.${bucket}.get("token")`)).toEqual(["token"]);
	});

	it("accepts single quotes and loose spacing, which authors write", () => {
		expect(referencedVariables("pm.environment.get( 'token' )")).toEqual(["token"]);
	});

	it("ignores a set, which defines a name rather than referencing one", () => {
		/*
		 * Listing it under "Referenced" would mark it unresolved in red for the
		 * one case where the script is about to create it.
		 *
		 * Excluded twice over, which is worth knowing because it means this test
		 * cannot isolate either half: the verb is `get`, *and* the pattern wants
		 * the quoted name followed straight by `)`, which a two-argument `set`
		 * never is. Broadening the verb alone changes nothing here - checked by
		 * mutation - so do not read this as a guard on the verb.
		 */
		expect(referencedVariables('pm.environment.set("token", "x")')).toEqual([]);
	});

	it("wants the name to be the only argument", () => {
		// The arity half, on its own. `get` with a second argument is not a
		// shape the pm API has, so matching it would be inventing a reference.
		expect(referencedVariables('pm.environment.get("token", "extra")')).toEqual([]);
	});
});

describe("templates", () => {
	it("reads a {{name}}", () => {
		expect(referencedVariables('const u = "{{base_url}}/orders"')).toEqual(["base_url"]);
	});

	it("trims, so {{ name }} is the same name", () => {
		expect(referencedVariables("{{ base_url }}")).toEqual(["base_url"]);
	});

	it("keeps two adjacent templates apart", () => {
		// The inner-brace exclusion is what stops `{{a}}{{b}}` matching as one.
		expect(referencedVariables("{{a}}{{b}}")).toEqual(["a", "b"]);
	});

	it("ignores an unclosed marker", () => {
		expect(referencedVariables("const x = {{oops")).toEqual([]);
	});
});

describe("the list the chips render", () => {
	it("takes both syntaxes from one script", () => {
		const script = 'pm.globals.get("run_id"); const u = "{{base_url}}";';
		expect(referencedVariables(script)).toEqual(["run_id", "base_url"]);
	});

	it("deduplicates across the two syntaxes", () => {
		// The same name reached both ways is one variable, and one chip.
		expect(referencedVariables('pm.environment.get("token") + "{{token}}"')).toEqual(["token"]);
	});

	it("groups by syntax, not by position in the script", () => {
		/*
		 * `{{zebra}}` comes first in the file and second in the list, because
		 * every `pm` reference is emitted before any template one. Both panels
		 * did this and it is kept, so the extraction stays a refactor - but it
		 * is worth pinning rather than leaving as an accident, since the panel
		 * chips only the first five.
		 */
		const script = '{{zebra}} pm.globals.get("apple")';
		expect(referencedVariables(script)).toEqual(["apple", "zebra"]);
	});

	it("finds nothing in a script that references nothing", () => {
		expect(referencedVariables("const x = 1;")).toEqual([]);
	});
});
