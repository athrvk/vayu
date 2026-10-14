/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `get_graphql_schema` introspects the way the request builder does (#2097).
 * The payload overlay is restated across the `electron/` boundary, so the two
 * copies are held to one answer here; and the SDL an agent reads is the
 * round trip through an introspection result, so that is held to the schema
 * it came from.
 */

import { describe, expect, test } from "vitest";
import { buildSchema, introspectionFromSchema, printSchema } from "graphql";
import { buildIntrospectionRequest } from "@/lib/graphql/introspect";
import type { ComposedRequest } from "@/types";
import { introspectionPayload, printSdl } from "./tools/graphql-schema.js";

const COMPOSED_BASE: ComposedRequest = {
	method: "GET",
	url: "https://api.example.com/graphql",
	headers: { "X-Tenant": "acme", "Content-Type": "text/plain" },
	// Everything below belongs to sending the request, and neither copy carries it.
	body: { mode: "graphql", content: "{ me { id } }" },
	elements: [{ id: "el_1", kind: "script.pre", enabled: true, config: { script: "1" } }],
	httpVersion: "auto",
	verifySSL: true,
};

const FIXTURES: Array<[string, ComposedRequest]> = [
	["a concrete auth", { ...COMPOSED_BASE, auth: { mode: "bearer", token: "t0k3n" } }],
	["an inherit auth", { ...COMPOSED_BASE, auth: { mode: "inherit" } }],
	["no auth", { ...COMPOSED_BASE }],
	["no headers", { method: "POST", url: "https://api.example.com/graphql" }],
];

describe("the introspection payload", () => {
	test.each(
		FIXTURES.flatMap(([name, c]) => [
			[name, "env_1", c] as const,
			[name, undefined, c] as const,
		])
	)("matches the renderer's for %s (environment %s)", async (_name, environmentId, composed) => {
		const ours = await introspectionPayload(composed, environmentId);
		expect(ours).toEqual(buildIntrospectionRequest(composed, environmentId));
		// The comparison is only worth something if it compared a real payload.
		expect(ours.transient).toBe(true);
		expect(String((ours.body as { content: string }).content)).toContain("__schema");
	});
});

/** One of each thing a query writer reads off a schema. */
const FIXTURE_SDL = `
"""An instant, as an ISO 8601 string."""
scalar DateTime

enum Status {
  OPEN
  CLOSED @deprecated(reason: "Use ARCHIVED.")
  ARCHIVED
}

interface Node {
  id: ID!
}

"""A customer order."""
type Order implements Node {
  id: ID!
  status: Status!
  placedAt: DateTime
  total: Float @deprecated(reason: "Use amount.")
  amount(currency: String = "EUR"): Float
}

type Refund implements Node {
  id: ID!
}

union Payment = Order | Refund

input OrderInput {
  status: Status = OPEN
  note: String
}

type Query {
  order(id: ID!): Order
  payments: [Payment!]!
}

type Mutation {
  createOrder(input: OrderInput!): Order
}
`;

describe("the SDL printer", () => {
	test("prints an introspection result as the schema it came from", async () => {
		const schema = buildSchema(FIXTURE_SDL);
		const printed = await printSdl(introspectionFromSchema(schema));

		expect(printed.sdl).toBe(printSchema(schema));
		expect(printed.sdl).toContain("@deprecated");
		expect(printed.types).toEqual([
			"DateTime",
			"Status",
			"Node",
			"Order",
			"Refund",
			"Payment",
			"OrderInput",
			"Query",
			"Mutation",
		]);
		expect(printed.unknownTypes).toEqual([]);
	});

	test("an empty type list prints the whole schema, as an omitted one does", async () => {
		const introspection = introspectionFromSchema(buildSchema(FIXTURE_SDL));
		expect(await printSdl(introspection, [])).toEqual(await printSdl(introspection));
	});

	test("prints only the named types, in the order given", async () => {
		const printed = await printSdl(introspectionFromSchema(buildSchema(FIXTURE_SDL)), [
			"Query",
			"Nope",
			"Order",
		]);
		expect(printed.types).toEqual(["Query", "Order"]);
		expect(printed.unknownTypes).toEqual(["Nope"]);
		expect(printed.sdl.indexOf("type Query")).toBe(0);
		expect(printed.sdl).toContain("\n\n");
		expect(printed.sdl).toContain('"""A customer order."""\ntype Order implements Node');
		expect(printed.sdl).not.toContain("Mutation");
	});
});
