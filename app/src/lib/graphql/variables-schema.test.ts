/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { buildSchema } from "graphql";
import type * as Monaco from "monaco-editor";
import { applyVariablesSchema, buildVariablesJsonSchema } from "./variables-schema";
import { templateTwinUri } from "./variables-diagnostics";

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

	/*
	 * A `{{token}}` is a parse failure to `getOperationFacts`, so before the mask
	 * one token anywhere cost the pane the schema for *every* variable the query
	 * declared - no validation, no completion, for a query the engine sends fine.
	 */
	it("derives the same schema for a templated query as for the token-free one", () => {
		const templated = buildVariablesJsonSchema(
			"query ($id: ID!, $active: Boolean) { user(id: $id, active: {{flag}}) { id } }",
			schema
		);
		const plain = buildVariablesJsonSchema(
			"query ($id: ID!, $active: Boolean) { user(id: $id, active: true) { id } }",
			schema
		);
		expect(templated).not.toBeNull();
		expect(templated).toEqual(plain);
	});

	it("still finds the variables when a token stands where a field would", () => {
		// The mask puts a GraphQL Name in a token's place, so it survives every
		// position a Name is grammatical in - a selection is one of them.
		const js = buildVariablesJsonSchema("query ($id: ID!) { user(id: $id) { {{f}} } }", schema);
		expect(Object.keys(js?.properties ?? {})).toEqual(["id"]);
	});

	it("is still null for a query that is broken for some other reason", () => {
		// Masking must not turn genuinely broken text into a schema.
		expect(buildVariablesJsonSchema("query ($id: ID!) { user(id: {{x}}", schema)).toBeNull();
	});
});

/**
 * The Monaco half, which had no coverage at all (sweep gap T6). `fileMatch` is
 * what keeps this schema on the variables editor: without it every JSON editor
 * in the app - request bodies included - would validate against the current
 * query's variables.
 */
describe("applyVariablesSchema", () => {
	const URI = "inmemory://model/variables.json";
	const OTHER = { uri: "inmemory://other.json", fileMatch: ["x.json"], schema: {} };

	function stubMonaco(schemas: unknown[] = []) {
		const diagnosticsOptions = { validate: false, schemas, allowComments: true };
		const monaco = {
			json: {
				jsonDefaults: {
					diagnosticsOptions,
					setDiagnosticsOptions: vi.fn(),
				},
			},
		};
		return {
			monaco: monaco as unknown as typeof Monaco,
			applied: () =>
				monaco.json.jsonDefaults.setDiagnosticsOptions.mock.calls[0]?.[0] as {
					validate: boolean;
					schemas: { uri: string; fileMatch?: string[] }[];
					allowComments?: boolean;
				},
		};
	}

	const QUERY = "query ($id: ID!) { user(id: $id) { id } }";

	it("registers the schema against the variables model and its masked twin only", () => {
		const { monaco, applied } = stubMonaco();
		applyVariablesSchema(monaco, URI, QUERY, schema);
		expect(applied().validate).toBe(true);
		expect(applied().schemas).toHaveLength(1);
		// The twin is the model the worker's markers come from, so a schema that
		// matched only the visible one would validate nothing anybody sees.
		expect(applied().schemas[0].fileMatch).toEqual([URI, templateTwinUri(URI)]);
	});

	it("keeps schemas other editors registered, and its own options", () => {
		const { monaco, applied } = stubMonaco([OTHER]);
		applyVariablesSchema(monaco, URI, QUERY, schema);
		expect(applied().schemas.map((s) => s.uri)).toContain(OTHER.uri);
		expect(applied().allowComments).toBe(true);
	});

	it("clears its own entry when the query declares no variables", () => {
		// Leaving a stale schema behind would validate the next query's variables
		// against the previous query's shape.
		const stale = {
			uri: "inmemory://graphql-variables-schema.json",
			fileMatch: [URI],
			schema: {},
		};
		const { monaco, applied } = stubMonaco([OTHER, stale]);
		applyVariablesSchema(monaco, URI, "{ user(id: 1) { id } }", schema);
		expect(applied().schemas.map((s) => s.uri)).toEqual([OTHER.uri]);
	});

	it("replaces its own entry rather than stacking copies of it", () => {
		const mine = {
			uri: "inmemory://graphql-variables-schema.json",
			fileMatch: [URI],
			schema: {},
		};
		const { monaco, applied } = stubMonaco([mine]);
		applyVariablesSchema(monaco, URI, QUERY, schema);
		expect(applied().schemas).toHaveLength(1);
	});
});
