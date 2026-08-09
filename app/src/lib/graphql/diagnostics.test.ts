/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildSchema } from "graphql";
import { computeGraphqlDiagnostics } from "./diagnostics";
import { fixtureSchema } from "@/test/graphql-schema-fixture";

const schema = buildSchema(`
  type Query { user(id: ID!): User }
  type User { id: ID name: String }
`);

describe("computeGraphqlDiagnostics", () => {
	it("returns a syntax diagnostic for an invalid query with no schema", () => {
		const markers = computeGraphqlDiagnostics("query: { user { id } }", null);
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0].severity).toBe("error");
		expect(markers[0].startLineNumber).toBeGreaterThanOrEqual(1);
		expect(markers[0].startColumn).toBeGreaterThanOrEqual(1);
	});

	it("returns no diagnostics for a valid query against the schema", () => {
		const markers = computeGraphqlDiagnostics("query { user(id: 1) { id name } }", schema);
		expect(markers).toEqual([]);
	});

	it("flags an unknown field when a schema is present", () => {
		const markers = computeGraphqlDiagnostics("query { user(id: 1) { id nope } }", schema);
		expect(markers.length).toBeGreaterThan(0);
		expect(markers.some((m) => /nope/i.test(m.message))).toBe(true);
	});

	it("returns no diagnostics for empty text", () => {
		expect(computeGraphqlDiagnostics("", schema)).toEqual([]);
	});

	/*
	 * The conversion from LSP's 0-based ranges to Monaco's 1-based ones is four
	 * `+ 1`s, and a suite that only asserts ">= 1" survives deleting any of them.
	 * These pin all four against a marker whose position is known by counting.
	 */
	it("converts LSP 0-based positions to Monaco 1-based ones, on both ends", () => {
		const markers = computeGraphqlDiagnostics("query {\n  user(id: 1) { nope }\n}", schema);
		const nope = markers.find((m) => /nope/.test(m.message));
		expect(nope).toBeDefined();
		expect(nope?.startLineNumber).toBe(2);
		expect(nope?.startColumn).toBe(17);
		expect(nope?.endLineNumber).toBe(2);
		expect(nope?.endColumn).toBe(22);
	});

	it("keeps a deprecation as a warning rather than an error", () => {
		// severity 2 is the only non-error the language service emits; mapping it
		// to "error" would paint every deprecation red.
		const markers = computeGraphqlDiagnostics(
			"query { user(id: 1) { nickname } }",
			fixtureSchema()
		);
		expect(markers).toHaveLength(1);
		expect(markers[0].severity).toBe("warning");
		expect(markers[0].message).toMatch(/deprecated/i);
	});
});

describe("`{{variable}}` tokens", () => {
	it("are not an error in an argument the schema types as something else", () => {
		expect(
			computeGraphqlDiagnostics("query { user(id: {{userId}}) { name } }", fixtureSchema())
		).toEqual([]);
	});

	it("are not a syntax error where a selection set is expected", () => {
		expect(computeGraphqlDiagnostics("query { user(id: 1) { {{fields}} } }", null)).toEqual([]);
	});

	/*
	 * The half a "no markers" assertion cannot see. An unmasked token is a *parse*
	 * failure, so the rest of the document is never validated at all - suppressing
	 * markers without masking would look identical here and silently switch off
	 * checking for every query that mentions a variable.
	 */
	it("still leave the rest of the document validated", () => {
		const markers = computeGraphqlDiagnostics(
			"query { user(id: {{userId}}) { nope } }",
			fixtureSchema()
		);
		expect(markers).toHaveLength(1);
		expect(markers[0].message).toMatch(/nope/);
	});

	it("do not hide a syntax error somewhere else in the document", () => {
		const markers = computeGraphqlDiagnostics("query { user(id: {{a}}) { name }", null);
		expect(markers.length).toBeGreaterThan(0);
	});
});
