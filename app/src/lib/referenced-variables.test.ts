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
 *
 * Each name now carries the syntax that found it (issue #659 item 3), because
 * the two are not the same claim: a `pm.*.get()` is read at run time, a
 * `{{name}}` in script text is never substituted, and a surface that paints
 * them alike teaches a false model of what a send will do.
 */

import { describe, it, expect } from "vitest";
import { describeColumnReference, referencedVariables } from "./referenced-variables";
import type { DataContractScope } from "@/types/domain";

/** The names alone, for the cases that are about extraction and not syntax. */
const names = (script: string) => referencedVariables(script).map((r) => r.name);

describe("the pm API", () => {
	it.each(["environment", "globals", "collectionVariables"])("reads pm.%s.get", (bucket) => {
		expect(referencedVariables(`pm.${bucket}.get("token")`)).toEqual([
			{ name: "token", via: "pm", reads: "scope" },
		]);
	});

	it("accepts single quotes and loose spacing, which authors write", () => {
		expect(names("pm.environment.get( 'token' )")).toEqual(["token"]);
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
	it("reads a {{name}}, and says it arrived as a template", () => {
		expect(referencedVariables('const u = "{{base_url}}/orders"')).toEqual([
			{ name: "base_url", via: "template", reads: null },
		]);
	});

	it("trims, so {{ name }} is the same name", () => {
		expect(names("{{ base_url }}")).toEqual(["base_url"]);
	});

	it("keeps two adjacent templates apart", () => {
		// The inner-brace exclusion is what stops `{{a}}{{b}}` matching as one.
		expect(names("{{a}}{{b}}")).toEqual(["a", "b"]);
	});

	it("ignores an unclosed marker", () => {
		expect(referencedVariables("const x = {{oops")).toEqual([]);
	});
});

describe("the list the chips render", () => {
	it("takes both syntaxes from one script", () => {
		const script = 'pm.globals.get("run_id"); const u = "{{base_url}}";';
		expect(referencedVariables(script)).toEqual([
			{ name: "run_id", via: "pm", reads: "scope" },
			{ name: "base_url", via: "template", reads: null },
		]);
	});

	it("deduplicates across the two syntaxes, keeping the one that reads", () => {
		/*
		 * The same name reached both ways is one variable, and one chip - and
		 * that chip must say `pm`. The script does read the variable; the
		 * `{{token}}` beside the call is decoration, and letting the weaker claim
		 * win would report a resolving reference as inert.
		 */
		expect(referencedVariables('pm.environment.get("token") + "{{token}}"')).toEqual([
			{ name: "token", via: "pm", reads: "scope" },
		]);
	});

	it("does not let a later template downgrade an earlier pm read", () => {
		// The order-dependent half of the rule above: template first, pm second.
		expect(referencedVariables('"{{token}}"; pm.globals.get("token");')).toEqual([
			{ name: "token", via: "pm", reads: "scope" },
		]);
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
		expect(names(script)).toEqual(["apple", "zebra"]);
	});

	it("finds nothing in a script that references nothing", () => {
		expect(referencedVariables("const x = 1;")).toEqual([]);
	});
});

/**
 * The two accessors the pattern left out entirely (issue #1063).
 *
 * Neither `pm.variables.get` nor `pm.iterationData.get` matched, so a name read
 * through either was not painted wrongly - it was chipped nowhere at all, which
 * is the failure no colour assertion can catch.
 */
describe("the accessors that can see a bound row", () => {
	it("reads pm.variables.get, and records that the row answers first", () => {
		expect(referencedVariables('pm.variables.get("email")')).toEqual([
			{ name: "email", via: "pm", reads: "merged" },
		]);
	});

	it("reads pm.iterationData.get, whose only source is the row", () => {
		expect(referencedVariables('pm.iterationData.get("email")')).toEqual([
			{ name: "email", via: "pm", reads: "row" },
		]);
	});

	it("reads a guarded call, which is how pm.iterationData is actually written", () => {
		// Its own documentation says to guard: the accessor is `undefined`
		// outside a data-driven run, so `?.` is the spelling in real scripts and
		// a pattern that missed it would miss most of them.
		expect(referencedVariables("pm.iterationData?.get('email')")).toEqual([
			{ name: "email", via: "pm", reads: "row" },
		]);
	});

	it("keeps the row-reading claim when a scope accessor names it too", () => {
		/*
		 * One chip for one name, and it has to be the claim that can be about a
		 * column. `pm.environment.get` cannot read the row whatever the
		 * collection declares, so letting it win would paint a column read as an
		 * undefined variable - the reading #604 removed from this row.
		 */
		expect(
			referencedVariables('pm.environment.get("email"); pm.variables.get("email");')
		).toEqual([{ name: "email", via: "pm", reads: "merged" }]);
	});

	it("does not let a scope accessor downgrade an earlier row read", () => {
		// The order-dependent half: the row-reading call comes first this time.
		expect(
			referencedVariables('pm.variables.get("email"); pm.environment.get("email");')
		).toEqual([{ name: "email", via: "pm", reads: "merged" }]);
	});
});

/**
 * Which references are column reads, which is what the chip colour turns on.
 *
 * The decision lives here rather than in the panel so both script surfaces read
 * one answer, and so these edges are reachable without rendering anything.
 */
describe("what a reference says about itself as a column", () => {
	const declared: DataContractScope = {
		collectionId: "col-orders",
		collectionName: "Orders",
		columns: ["email"],
	};
	/** No scope defines anything, unless a case says otherwise. */
	const definesNothing = () => false;
	const first = (script: string) => referencedVariables(script)[0];

	const describeFirst = (
		script: string,
		contract: DataContractScope | null | undefined,
		definesVariable: (name: string) => boolean = definesNothing
	) => describeColumnReference(first(script), contract, definesVariable);

	describe("read through pm.iterationData, whose only source is the row", () => {
		it("is a declared column of the contract in scope", () => {
			expect(describeFirst('pm.iterationData.get("email")', declared)).toMatchObject({
				tone: "muted",
				note: "declared in Orders",
			});
		});

		it("warns - never destructive - when the contract does not declare it", () => {
			const { collectionName, collectionId } = declared;
			const other = { collectionId, collectionName, columns: ["name"] };
			expect(describeFirst('pm.iterationData.get("email")', other)).toMatchObject({
				tone: "warning",
				note: "declared: name",
			});
		});

		it("is still a column with no contract in scope, not an undefined variable", () => {
			/*
			 * The case that has to answer rather than fall through: a column can
			 * never be in `allVariables`, so a null here would hand the chip the
			 * resolved/unresolved pair and paint every column read destructive red
			 * - the reading issue #604 removed from this exact row.
			 */
			expect(describeFirst('pm.iterationData.get("email")', undefined)).toMatchObject({
				tone: "muted",
			});
		});
	});

	describe("read through pm.variables, which reads the row and then the scopes", () => {
		it("is a bound column when the contract declares it and no scope does", () => {
			expect(describeFirst('pm.variables.get("email")', declared)).toMatchObject({
				tone: "muted",
				note: expect.stringContaining("bound row's column answers this name"),
			});
		});

		it("stays the variable it also is when a scope defines the name", () => {
			/*
			 * The row does win at run time while one is bound (issue #1007), but
			 * which of the two a surface should *paint* is issue #1064's question,
			 * and the builder draws this same line for a bare `{{email}}` today.
			 * Answering it differently here would make the two disagree.
			 */
			expect(describeFirst('pm.variables.get("email")', declared, (n) => n === "email")).toBe(
				null
			);
		});

		it("is an ordinary variable read when no contract declares the name", () => {
			expect(describeFirst('pm.variables.get("token")', declared)).toBe(null);
			expect(describeFirst('pm.variables.get("token")', undefined)).toBe(null);
		});
	});

	it("is never a column read through an accessor that cannot see the row", () => {
		// The negative half of the rule: `pm.environment.get("email")` reads the
		// environment whatever the collection declares, so a column paint there
		// would describe a read that cannot happen.
		expect(describeFirst('pm.environment.get("email")', declared)).toBe(null);
		expect(describeFirst('pm.globals.get("email")', declared)).toBe(null);
		expect(describeFirst('pm.collectionVariables.get("email")', declared)).toBe(null);
	});

	it("is never a column read for a name the script only contains", () => {
		// Nothing interpolates script text (decision D16), so a `{{email}}` here
		// reads no column however the contract is written.
		expect(describeFirst('const to = "{{email}}"', declared)).toBe(null);
	});
});
