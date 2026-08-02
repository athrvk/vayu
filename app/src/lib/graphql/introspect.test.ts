/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql";

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: vi.fn(), executeRequest: vi.fn() },
}));
import { apiService } from "@/services/api";
import {
	introspectSchema,
	buildIntrospectionRequest,
	type IntrospectionTarget,
} from "./introspect";
import type { ComposedRequest, SanityResult } from "@/types";

function introspectionJSONFor(sdl: string): unknown {
	const schema = buildSchema(sdl);
	const res = graphqlSync({ schema, source: getIntrospectionQuery() });
	return res.data;
}

const SDL = "type Query { user(id: ID!): User }\ntype User { id: ID name: String }";

/** The editor state as typed: `{{vars}}` intact, auth left as `inherit`. */
const TARGET: IntrospectionTarget = {
	url: "{{base}}/gql",
	headers: { "X-Team": "{{team}}" },
	auth: { mode: "inherit" },
	collectionId: "col_1",
	environmentId: "env_1",
};

/** What the engine hands back: everything resolved, `inherit` walked. */
const COMPOSED = {
	method: "POST",
	url: "https://api.test/gql",
	headers: { "X-Team": "payments" },
	auth: { mode: "bearer", token: "sk_live" },
};

function mockExecute(result: { status: number; bodyRaw: string }) {
	vi.mocked(apiService.composeRequest).mockResolvedValue(COMPOSED);
	vi.mocked(apiService.executeRequest).mockResolvedValue(result as SanityResult);
}

beforeEach(() => vi.clearAllMocks());

describe("buildIntrospectionRequest", () => {
	it("overlays the introspection query onto a composed payload", () => {
		const req = buildIntrospectionRequest({
			...COMPOSED,
			// Composition returns the whole request; introspection is not sending
			// the user's body or running their scripts.
			body: { mode: "json", content: '{"real":"body"}' },
			preRequestScripts: [{ origin: "collection", id: "c1", script: "pm.test()" }],
		} as ComposedRequest);
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://api.test/gql");
		expect(req.headers?.["Content-Type"]).toBe("application/json");
		expect(req.headers?.["X-Team"]).toBe("payments");
		expect(req.auth).toEqual({ mode: "bearer", token: "sk_live" });
		const body = req.body as { mode: string; content: string };
		expect(body.mode).toBe("json");
		expect(JSON.parse(body.content).query).toContain("IntrospectionQuery");
		expect(req.preRequestScripts).toBeUndefined();
	});

	it("omits auth entirely when composition resolved it to nothing", () => {
		const req = buildIntrospectionRequest({ ...COMPOSED, auth: undefined } as ComposedRequest);
		expect("auth" in req).toBe(false);
	});

	it("never puts an unresolved inherit on the wire", () => {
		const req = buildIntrospectionRequest({
			...COMPOSED,
			auth: { mode: "inherit" },
		} as ComposedRequest);
		expect(req.auth).toBeUndefined();
	});
});

describe("introspectSchema", () => {
	it("composes the target unresolved and executes with the resolved auth", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ data: introspectionJSONFor(SDL) }) });
		await introspectSchema(TARGET);

		// Compose gets the editor state as typed, plus the scope that resolves it.
		expect(apiService.composeRequest).toHaveBeenCalledWith({
			request: {
				method: "POST",
				url: "{{base}}/gql",
				headers: { "X-Team": "{{team}}" },
				auth: { mode: "inherit" },
			},
			collectionId: "col_1",
			environmentId: "env_1",
		});

		// Execute gets what compose resolved - this is the assertion that goes
		// red if introspection stops composing and sends the target's own
		// headers again (the #228 defect).
		const sent = vi.mocked(apiService.executeRequest).mock.calls[0][0];
		expect(sent.url).toBe("https://api.test/gql");
		expect(sent.auth).toEqual({ mode: "bearer", token: "sk_live" });
		expect(sent.headers?.["X-Team"]).toBe("payments");
	});

	it("omits auth from the compose body when the request has none", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ data: introspectionJSONFor(SDL) }) });
		await introspectSchema({ url: "https://api.test/gql", headers: {} });
		const composeBody = vi.mocked(apiService.composeRequest).mock.calls[0][0];
		expect("auth" in (composeBody.request ?? {})).toBe(false);
	});

	it("builds a GraphQLSchema from a successful introspection response", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ data: introspectionJSONFor(SDL) }) });
		const schema = await introspectSchema(TARGET);
		expect(schema.getQueryType()?.getFields().user).toBeDefined();
	});

	it("throws when the response contains GraphQL errors", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ errors: [{ message: "nope" }] }) });
		await expect(introspectSchema(TARGET)).rejects.toThrow(/nope/);
	});

	it("throws on a non-2xx status", async () => {
		mockExecute({ status: 500, bodyRaw: "boom" });
		await expect(introspectSchema(TARGET)).rejects.toThrow();
	});

	it("throws when body is not valid JSON", async () => {
		mockExecute({ status: 200, bodyRaw: "<html>" });
		await expect(introspectSchema(TARGET)).rejects.toThrow();
	});

	it("surfaces a compose failure instead of sending an unresolved request", async () => {
		vi.mocked(apiService.composeRequest).mockRejectedValue(new Error("collection not found"));
		await expect(introspectSchema(TARGET)).rejects.toThrow(/collection not found/);
		expect(apiService.executeRequest).not.toHaveBeenCalled();
	});
});
