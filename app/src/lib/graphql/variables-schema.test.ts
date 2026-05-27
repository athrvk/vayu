/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildSchema } from "graphql";
import { buildVariablesJsonSchema } from "./variables-schema";

const schema = buildSchema(`
  type Query { user(id: ID!, active: Boolean): User }
  type User { id: ID name: String }
`);

describe("buildVariablesJsonSchema", () => {
	it("returns a schema with required + optional variables from the query", () => {
		const js = buildVariablesJsonSchema(
			"query ($id: ID!, $active: Boolean) { user(id: $id, active: $active) { id } }",
			schema
		);
		expect(js).not.toBeNull();
		expect(js?.type).toBe("object");
		expect(Object.keys(js?.properties ?? {})).toEqual(["id", "active"]);
		expect(js?.required).toEqual(["id"]);
	});

	it("returns null when the query declares no variables", () => {
		expect(buildVariablesJsonSchema("{ user(id: 1) { id } }", schema)).toBeNull();
	});

	it("returns null without a schema", () => {
		expect(
			buildVariablesJsonSchema("query ($id: ID!) { user(id: $id) { id } }", null)
		).toBeNull();
	});

	it("returns null for an unparseable query", () => {
		expect(buildVariablesJsonSchema("query: { broken", schema)).toBeNull();
	});
});
