/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildSchema } from "graphql";
import { computeGraphqlDiagnostics } from "./diagnostics";

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
});
