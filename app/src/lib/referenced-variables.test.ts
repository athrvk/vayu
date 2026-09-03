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
import {
	describeColumnReference,
	describeScopedRead,
	referencedVariables,
} from "./referenced-variables";
import type { DataContractScope, VariableOrigin } from "@/types/domain";

/** The names alone, for the cases that are about extraction and not syntax. */
const names = (script: string) => referencedVariables(script).map((r) => r.name);

describe("the pm API", () => {
	it.each(["environment", "globals", "collectionVariables"])("reads pm.%s.get", (bucket) => {
		const scope = { environment: "environment", globals: "global", collectionVariables: "collection" }[
			bucket
		];
		expect(referencedVariables(`pm.${bucket}.get("token")`)).toEqual([
			{ name: "token", via: "pm", reads: "scope", scope },
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
			{ name: "base_url", via: "template", reads: null, scope: null },
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
			{ name: "run_id", via: "pm", reads: "scope", scope: "global" },
			{ name: "base_url", via: "template", reads: null, scope: null },
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
			{ name: "token", via: "pm", reads: "scope", scope: "environment" },
		]);
	});

	it("does not let a later template downgrade an earlier pm read", () => {
		// The order-dependent half of the rule above: template first, pm second.
		expect(referencedVariables('"{{token}}"; pm.globals.get("token");')).toEqual([
			{ name: "token", via: "pm", reads: "scope", scope: "global" },
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
			{ name: "email", via: "pm", reads: "merged", scope: null },
		]);
	});

	it("reads pm.iterationData.get, whose only source is the row", () => {
		expect(referencedVariables('pm.iterationData.get("email")')).toEqual([
			{ name: "email", via: "pm", reads: "row", scope: null },
		]);
	});

	it("reads a guarded call, which is how pm.iterationData is actually written", () => {
		// Its own documentation says to guard: the accessor is `undefined`
		// outside a data-driven run, so `?.` is the spelling in real scripts and
		// a pattern that missed it would miss most of them.
		expect(referencedVariables("pm.iterationData?.get('email')")).toEqual([
			{ name: "email", via: "pm", reads: "row", scope: null },
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
		).toEqual([{ name: "email", via: "pm", reads: "merged", scope: null }]);
	});

	it("does not let a scope accessor downgrade an earlier row read", () => {
		// The order-dependent half: the row-reading call comes first this time.
		expect(
			referencedVariables('pm.variables.get("email"); pm.environment.get("email");')
		).toEqual([{ name: "email", via: "pm", reads: "merged", scope: null }]);
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

/**
 * The read that looks healthy and returns nothing (issue #1196).
 *
 * The owner hit this in real use: an enabled, empty `shop_domain` at collection
 * scope - the usual leftover of a Postman import's initial-value placeholders -
 * makes `pm.collectionVariables.get("shop_domain")` honestly return `''`, while
 * `{{shop_domain}}` in the URL bar resolves the environment's real value through
 * the full ladder. The engine was verified correct and is untouched; what was
 * missing is any surface saying the two answers differ.
 *
 * Origins arrive in the order `useVariableResolver` builds them - globals, then
 * the collection chain root-first, then the environment - because "the answer
 * this accessor gives" is the *last enabled* definition of its own scope, and a
 * helper that read them in any other order would agree with the resolver only by
 * accident.
 */
const origin = (over: Partial<VariableOrigin> & { scope: VariableOrigin["scope"] }): VariableOrigin => ({
	value: "",
	enabled: true,
	winner: false,
	...over,
});

/** The reported scenario, as `referencedVariables` reports it. */
const scopedRead = (script: string) => referencedVariables(script)[0];

const COLLECTION_GET = 'pm.collectionVariables.get("shop_domain")';

describe("a single-scope read whose own scope answers emptily", () => {
	it("warns when the scope holds an enabled empty row and another scope holds the value", () => {
		const result = describeScopedRead(scopedRead(COLLECTION_GET), [
			origin({ scope: "collection", sourceName: "Shop API", value: "" }),
			origin({
				scope: "environment",
				sourceName: "Staging",
				value: "shop.example.com",
				winner: true,
			}),
		]);

		expect(result).not.toBeNull();
		// Amber, never destructive: the read works and the name resolves - it just
		// does not resolve *here*.
		expect(result?.tone).toBe("warning");
		// Both facts the issue asks the tooltip to name: what this read returns,
		// and where the value the author is looking at actually lives.
		expect(result?.description).toContain("Empty at collection scope");
		expect(result?.description).toContain('returns ""');
		expect(result?.note).toContain("environment - Staging");
		expect(result?.note).toContain('pm.variables.get("shop_domain")');
	});

	it("says undefined, not empty, when the scope defines the name nowhere", () => {
		const result = describeScopedRead(scopedRead(COLLECTION_GET), [
			origin({ scope: "environment", sourceName: "Staging", value: "shop.example.com" }),
		]);

		expect(result?.tone).toBe("warning");
		expect(result?.description).toContain("Not defined at collection scope");
		expect(result?.description).toContain("returns undefined");
	});

	it("looks past a disabled row in its own scope, exactly as the engine does", () => {
		// D17: a disabled definition is looked past rather than stopped at, so this
		// accessor reaches nothing at all and the answer is `undefined`.
		const result = describeScopedRead(scopedRead(COLLECTION_GET), [
			origin({ scope: "collection", value: "stale.example.com", enabled: false }),
			origin({ scope: "environment", sourceName: "Staging", value: "shop.example.com" }),
		]);

		expect(result?.description).toContain("Not defined at collection scope");
	});

	it("takes the nearest enabled definition of its own scope, not the first", () => {
		// Root-first, so the leaf's empty row is the one the accessor returns even
		// though an ancestor in the same chain holds a value.
		const result = describeScopedRead(scopedRead(COLLECTION_GET), [
			origin({ scope: "collection", sourceName: "Root", value: "root.example.com" }),
			origin({ scope: "collection", sourceName: "Leaf", value: "" }),
			origin({ scope: "environment", sourceName: "Staging", value: "shop.example.com" }),
		]);

		expect(result?.description).toContain("Empty at collection scope");
	});

	it("names the shadowing source without printing its value, which may be secret", () => {
		const result = describeScopedRead(scopedRead(COLLECTION_GET), [
			origin({ scope: "collection", value: "" }),
			origin({
				scope: "environment",
				sourceName: "Staging",
				value: "sk_live_do_not_print",
				secret: true,
			}),
		]);

		expect(result?.note).toContain("environment - Staging");
		expect(result?.note).not.toContain("sk_live_do_not_print");
	});
});

describe("the reads that must stay silent", () => {
	it("says nothing about a scope that answers with a value", () => {
		expect(
			describeScopedRead(scopedRead(COLLECTION_GET), [
				origin({ scope: "collection", value: "shop.example.com", winner: true }),
			])
		).toBeNull();
	});

	it("says nothing when the name is empty everywhere - there is no contradiction", () => {
		expect(
			describeScopedRead(scopedRead(COLLECTION_GET), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "environment", sourceName: "Staging", value: "" }),
			])
		).toBeNull();
	});

	it("says nothing when nothing defines the name - that is the destructive chip's answer", () => {
		expect(describeScopedRead(scopedRead(COLLECTION_GET), [])).toBeNull();
	});

	it("does not count a disabled definition elsewhere as the value that shadows", () => {
		// A switched-off row answers nothing either, so `{{shop_domain}}` and this
		// read agree and there is no trap to point at.
		expect(
			describeScopedRead(scopedRead(COLLECTION_GET), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "environment", value: "shop.example.com", enabled: false }),
			])
		).toBeNull();
	});

	it("never warns on the merged read, which returns the winning value", () => {
		// `pm.variables.get` is the correct escape from this trap, so warning on it
		// would point the author away from the fix.
		expect(
			describeScopedRead(scopedRead('pm.variables.get("shop_domain")'), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "environment", value: "shop.example.com", winner: true }),
			])
		).toBeNull();
	});

	it("never warns on a row read, whose only source is the bound row", () => {
		expect(
			describeScopedRead(scopedRead('pm.iterationData.get("shop_domain")'), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "environment", value: "shop.example.com" }),
			])
		).toBeNull();
	});

	it("never warns on a {{name}} the script merely contains", () => {
		// Nothing substitutes it, so no answer about what a scope holds says
		// anything true about this script.
		expect(
			describeScopedRead(scopedRead('const u = "{{shop_domain}}"'), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "environment", value: "shop.example.com" }),
			])
		).toBeNull();
	});

	it("does not treat a bound row as the scope that shadows", () => {
		// The row is not a scope - `pm.iterationData` is its accessor, and
		// `describeColumnReference` already paints reads of it.
		expect(
			describeScopedRead(scopedRead(COLLECTION_GET), [
				origin({ scope: "collection", value: "" }),
				origin({ scope: "row", value: "shop.example.com", winner: true }),
			])
		).toBeNull();
	});
});
