/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql";

vi.mock("@/services/api", () => ({ apiService: { executeRequest: vi.fn() } }));
import { apiService } from "@/services/api";
import { introspectSchema, buildIntrospectionRequest } from "./introspect";

function introspectionJSONFor(sdl: string): unknown {
	const schema = buildSchema(sdl);
	const res = graphqlSync({ schema, source: getIntrospectionQuery() });
	return res.data;
}

const SDL = "type Query { user(id: ID!): User }\ntype User { id: ID name: String }";

beforeEach(() => vi.clearAllMocks());

describe("buildIntrospectionRequest", () => {
	it("builds a POST with the introspection query and JSON content-type", () => {
		const req = buildIntrospectionRequest("https://api.test/gql", {
			Authorization: "Bearer x",
		});
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://api.test/gql");
		expect(req.headers?.["Content-Type"]).toBe("application/json");
		expect(req.headers?.Authorization).toBe("Bearer x");
		const body = req.body as { mode: string; content: string };
		expect(body.mode).toBe("json");
		expect(JSON.parse(body.content).query).toContain("IntrospectionQuery");
	});
});

describe("introspectSchema", () => {
	it("builds a GraphQLSchema from a successful introspection response", async () => {
		const data = introspectionJSONFor(SDL);
		(apiService.executeRequest as any).mockResolvedValue({
			status: 200,
			bodyRaw: JSON.stringify({ data }),
		});
		const schema = await introspectSchema("https://api.test/gql", {});
		expect(schema.getQueryType()?.getFields().user).toBeDefined();
	});

	it("throws when the response contains GraphQL errors", async () => {
		(apiService.executeRequest as any).mockResolvedValue({
			status: 200,
			bodyRaw: JSON.stringify({ errors: [{ message: "nope" }] }),
		});
		await expect(introspectSchema("https://api.test/gql", {})).rejects.toThrow(/nope/);
	});

	it("throws on a non-2xx status", async () => {
		(apiService.executeRequest as any).mockResolvedValue({ status: 500, bodyRaw: "boom" });
		await expect(introspectSchema("https://api.test/gql", {})).rejects.toThrow();
	});

	it("throws when body is not valid JSON", async () => {
		(apiService.executeRequest as any).mockResolvedValue({ status: 200, bodyRaw: "<html>" });
		await expect(introspectSchema("https://api.test/gql", {})).rejects.toThrow();
	});
});
