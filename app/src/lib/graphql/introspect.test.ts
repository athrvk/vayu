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
	IntrospectionError,
	MAX_INTROSPECTION_CHARS,
	type IntrospectionFailureKind,
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

	// The #382 assertions: a schema load is not a run the user made, so it must
	// leave no History entry, and it must reach the endpoint through the same
	// cookie jar the endpoint's real requests use.
	it("marks the execution transient so it files no run", () => {
		const req = buildIntrospectionRequest(COMPOSED as ComposedRequest);
		expect(req.transient).toBe(true);
	});

	it("carries the environment through so introspection uses its cookie jar", () => {
		const req = buildIntrospectionRequest(COMPOSED as ComposedRequest, "env_1");
		expect(req.environmentId).toBe("env_1");
	});

	it("omits environmentId entirely when the target has no environment", () => {
		// Absent, not empty: the engine reads an absent id as the
		// no-environment jar, and `""` would be a different thing to explain.
		const req = buildIntrospectionRequest(COMPOSED as ComposedRequest);
		expect("environmentId" in req).toBe(false);
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
		// Composed by the environment, and sent through that environment's
		// cookie jar - the two halves of #382 on the send itself.
		expect(sent.transient).toBe(true);
		expect(sent.environmentId).toBe("env_1");
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

	it("throws when the response is valid JSON with neither data nor errors", async () => {
		// A proxy or gateway that answers 200 with `{}` - the branch between
		// "GraphQL said no" and "this is not JSON", which reached
		// buildClientSchema with undefined before it was guarded.
		mockExecute({ status: 200, bodyRaw: "{}" });
		await expect(introspectSchema(TARGET)).rejects.toThrow(/no introspection data/i);
	});

	it("surfaces an execute failure rather than reporting an empty schema", async () => {
		vi.mocked(apiService.composeRequest).mockResolvedValue(COMPOSED);
		vi.mocked(apiService.executeRequest).mockRejectedValue(new Error("engine unreachable"));
		await expect(introspectSchema(TARGET)).rejects.toThrow(/engine unreachable/);
	});

	it("surfaces a compose failure instead of sending an unresolved request", async () => {
		vi.mocked(apiService.composeRequest).mockRejectedValue(new Error("collection not found"));
		await expect(introspectSchema(TARGET)).rejects.toThrow(/collection not found/);
		expect(apiService.executeRequest).not.toHaveBeenCalled();
	});
});

/*
 * Every failure used to arrive as a bare Error and collapse into one badge
 * reading "introspection failed" - so an expired token and an endpoint with
 * introspection switched off, whose fixes have nothing in common, were
 * indistinguishable to the user (#383). The kind is decided here because this
 * is the only layer still holding the status, the error list and the body.
 */
describe("failure classification", () => {
	async function kindOf(promise: Promise<unknown>): Promise<IntrospectionFailureKind> {
		try {
			await promise;
		} catch (e) {
			expect(e).toBeInstanceOf(IntrospectionError);
			return (e as IntrospectionError).kind;
		}
		throw new Error("expected introspection to fail");
	}

	it.each([401, 403])("classifies HTTP %i as a credentials problem", async (status) => {
		mockExecute({ status, bodyRaw: "" });
		expect(await kindOf(introspectSchema(TARGET))).toBe("auth");
	});

	it("classifies any other non-2xx as an http failure, not an auth one", async () => {
		mockExecute({ status: 500, bodyRaw: "boom" });
		expect(await kindOf(introspectSchema(TARGET))).toBe("http");
	});

	it("classifies a server that says introspection is disabled as unsupported", async () => {
		mockExecute({
			status: 200,
			bodyRaw: JSON.stringify({
				errors: [{ message: "GraphQL introspection is not allowed by Apollo Server" }],
			}),
		});
		expect(await kindOf(introspectSchema(TARGET))).toBe("unsupported");
	});

	it("classifies other GraphQL errors as parse, keeping the server's own words", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ errors: [{ message: "nope" }] }) });
		await expect(introspectSchema(TARGET)).rejects.toThrow(/nope/);
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ errors: [{ message: "nope" }] }) });
		expect(await kindOf(introspectSchema(TARGET))).toBe("parse");
	});

	it("classifies a non-JSON answer as parse", async () => {
		mockExecute({ status: 200, bodyRaw: "<html>" });
		expect(await kindOf(introspectSchema(TARGET))).toBe("parse");
	});

	it("classifies JSON that is not an introspection result as parse", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ data: { notASchema: true } }) });
		expect(await kindOf(introspectSchema(TARGET))).toBe("parse");
	});

	it("classifies never getting an answer as network", async () => {
		vi.mocked(apiService.composeRequest).mockResolvedValue(COMPOSED);
		vi.mocked(apiService.executeRequest).mockRejectedValue(new Error("engine unreachable"));
		expect(await kindOf(introspectSchema(TARGET))).toBe("network");
	});

	/*
	 * The parse below is synchronous and holds the renderer's only thread, so a
	 * pathological response has to be refused before it is parsed rather than
	 * after - the refusal is what keeps the window responsive.
	 */
	it("refuses a response over the size cap without parsing it", async () => {
		const oversized = `{"data":"${"x".repeat(MAX_INTROSPECTION_CHARS)}"}`;
		mockExecute({ status: 200, bodyRaw: oversized });
		expect(await kindOf(introspectSchema(TARGET))).toBe("too-large");
	});

	it("accepts a large response under the cap", async () => {
		mockExecute({ status: 200, bodyRaw: JSON.stringify({ data: introspectionJSONFor(SDL) }) });
		await expect(introspectSchema(TARGET)).resolves.toBeDefined();
	});
});
