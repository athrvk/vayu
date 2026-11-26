/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { buildSchema, introspectionFromSchema } from "graphql";
import { dispatchTool, MAX_INTROSPECTION_BYTES, MAX_SCHEMA_SDL_BYTES, TOOLS } from "../tools.js";
import type { EngineClient } from "../engine-client.js";
import { descriptionOf, listingEnv1, fakeClient, ctxWith, firstText } from "../tools.testkit.js";

describe("get_graphql_schema", () => {
	const ENDPOINT = "https://api.example.com/graphql";
	const ALLOWED = { allowlist: ["api.example.com"] };
	const FIXTURE_SDL = `
		type Order { id: ID! total: Float }
		type Query { order(id: ID!): Order }
	`;

	/** What `POST /execute` answers when the endpoint returns @p sdl's introspection. */
	const introspected = (sdl: string) => ({
		status: 200,
		bodyRaw: JSON.stringify({ data: introspectionFromSchema(buildSchema(sdl)) }),
	});

	/** A stored GraphQL request as `/compose` returns it by id. */
	const STORED = {
		method: "GET",
		url: ENDPOINT,
		headers: [
			{ name: "X-Tenant", value: "acme" },
			{ name: "x-tenant", value: "beta" },
			{ name: "content-type", value: "text/plain" },
		],
		body: { mode: "graphql", content: "{ order(id: 1) { id } }" },
		auth: { mode: "bearer", token: "t0k3n" },
	};

	function clientFor(composed: unknown, executed: unknown = introspected(FIXTURE_SDL)) {
		return fakeClient({
			listEnvironments: listingEnv1(),
			composeRequest: vi.fn().mockResolvedValue(composed),
			executeRequest: vi.fn().mockResolvedValue(executed),
		});
	}

	const executedPayload = (client: EngineClient) =>
		(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;

	test("is a read tool carrying read-only annotations", () => {
		const tool = TOOLS.find((t) => t.name === "get_graphql_schema");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(descriptionOf(tool)).toContain(String(MAX_SCHEMA_SDL_BYTES));
		expect(descriptionOf(tool)).toContain("GUARDED");
	});

	test("composes a saved request as stored and introspects it transiently", async () => {
		const client = clientFor(STORED);
		const res = await dispatchTool(
			"get_graphql_schema",
			{ requestId: "req_1", environmentId: "env_1" },
			ctxWith(client, ALLOWED)
		);
		expect(res.isError).toBeFalsy();
		expect(client.composeRequest).toHaveBeenCalledWith(
			{ requestId: "req_1", environmentId: "env_1" },
			undefined
		);

		const payload = executedPayload(client);
		expect(payload).toMatchObject({
			method: "POST",
			url: ENDPOINT,
			transient: true,
			environmentId: "env_1",
			auth: STORED.auth,
			// The composed lines, a repeat kept, with the one Content-Type this
			// request needs in place of the composed one.
			headers: [
				{ name: "X-Tenant", value: "acme" },
				{ name: "x-tenant", value: "beta" },
				{ name: "Content-Type", value: "application/json" },
			],
		});
		const body = payload.body as { mode: string; content: string };
		expect(body.mode).toBe("json");
		expect(body.content).toContain("__schema");
		// The stored body belongs to sending the request, not to its schema.
		expect(body.content).not.toContain("order(id: 1)");

		const answer = JSON.parse(firstText(res));
		expect(answer.sdl).toContain("type Query");
		expect(answer.sdlTruncated).toBe(false);
		expect(answer.sdlBytes).toBe(Buffer.byteLength(answer.sdl, "utf8"));
		expect(typeof answer.fetchedAt).toBe("number");
		expect(answer.types).toEqual(["Order", "Query"]);
		expect(answer).not.toHaveProperty("cached");
	});

	test("composes an inline endpoint with its own headers and auth", async () => {
		const client = fakeClient({
			executeRequest: vi.fn().mockResolvedValue(introspected(FIXTURE_SDL)),
		});
		const auth = { mode: "bearer", token: "{{token}}" };
		const res = await dispatchTool(
			"get_graphql_schema",
			{ url: ENDPOINT, headers: { "X-Tenant": "acme" }, auth, collectionId: "col_1" },
			ctxWith(client, ALLOWED)
		);
		expect(res.isError).toBeFalsy();
		expect(client.composeRequest).toHaveBeenCalledWith(
			{
				request: { method: "POST", url: ENDPOINT, headers: { "X-Tenant": "acme" }, auth },
				collectionId: "col_1",
				environmentId: undefined,
			},
			undefined
		);
	});

	describe("the endpoint it echoes", () => {
		const SECRET_URL = `${ENDPOINT}?api_key=S3CR3T`;
		const composed = {
			...STORED,
			url: SECRET_URL,
			auth: { mode: "apikey", key: "api_key", value: "S3CR3T", in: "query" },
		};

		test("is withheld as a saved request's url is, with reveal off", async () => {
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1" },
				ctxWith(clientFor(composed), ALLOWED)
			);
			expect(JSON.parse(firstText(res)).endpoint).toBe(`${ENDPOINT}?api_key=`);
			expect(JSON.stringify(res)).not.toContain("S3CR3T");
		});

		test("is shown whole with reveal on", async () => {
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1" },
				ctxWith(clientFor(composed), { ...ALLOWED, revealSecretsToAgents: true })
			);
			expect(JSON.parse(firstText(res)).endpoint).toBe(SECRET_URL);
		});
	});

	describe("the allowlist", () => {
		test("refuses a composed host off the list before any traffic", async () => {
			const client = clientFor(STORED);
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1" },
				ctxWith(client, { allowlist: ["other.example.com"] })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("api.example.com");
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("refuses an inline url whose host is an unresolved variable", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"get_graphql_schema",
				{ url: "https://{{host}}/graphql" },
				ctxWith(client, ALLOWED)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/unresolved/);
			expect(client.executeRequest).not.toHaveBeenCalled();
		});
	});

	describe("the size cap", () => {
		/** Enough object types to print past the cap. */
		const LARGE_SDL = (() => {
			const fields = Array.from({ length: 20 }, (_, i) => `field${i}: String`).join(" ");
			const types = Array.from({ length: 800 }, (_, i) => `type T${i} { ${fields} }`);
			return `${types.join("\n")}\ntype Query { first: T0 }`;
		})();

		test("truncates SDL past the cap and reports the true size", async () => {
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1" },
				ctxWith(clientFor(STORED, introspected(LARGE_SDL)), ALLOWED)
			);
			const answer = JSON.parse(firstText(res));
			expect(answer.sdlTruncated).toBe(true);
			expect(answer.sdlBytes).toBeGreaterThan(MAX_SCHEMA_SDL_BYTES);
			expect(Buffer.byteLength(answer.sdl, "utf8")).toBeLessThanOrEqual(MAX_SCHEMA_SDL_BYTES);
			// The table of contents is whole, so the cut-off types can be asked for.
			expect(answer.types).toContain("T799");
		});

		test("prints only the named types, whole", async () => {
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1", types: ["Query"] },
				ctxWith(clientFor(STORED, introspected(LARGE_SDL)), ALLOWED)
			);
			const answer = JSON.parse(firstText(res));
			expect(answer.sdlTruncated).toBe(false);
			expect(answer.sdl).toBe("type Query {\n  first: T0\n}");
			expect(answer.types).toEqual(["Query"]);
			expect(answer.unknownTypes).toEqual([]);
		});

		test("lists a name the schema does not declare rather than failing", async () => {
			const res = await dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1", types: ["Nope"] },
				ctxWith(clientFor(STORED), ALLOWED)
			);
			expect(res.isError).toBeFalsy();
			const answer = JSON.parse(firstText(res));
			expect(answer.unknownTypes).toEqual(["Nope"]);
			expect(answer.sdl).toBe("");
		});
	});

	describe("the error ladder", () => {
		const call = (executed: unknown) =>
			dispatchTool(
				"get_graphql_schema",
				{ requestId: "req_1" },
				ctxWith(clientFor(STORED, executed), ALLOWED)
			);

		test("names a rejected status without echoing the body", async () => {
			const res = await call({ status: 401, bodyRaw: '{"error":"BODY-SENTINEL"}' });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("401");
			expect(firstText(res)).not.toContain("BODY-SENTINEL");
		});

		test("says an endpoint disallows introspection", async () => {
			const res = await call({
				status: 200,
				bodyRaw: JSON.stringify({ errors: [{ message: "introspection is not allowed" }] }),
			});
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/disallows introspection/);
		});

		test.each([
			[
				"an endpoint never reached",
				"unreachable",
				{ status: 0, errorCode: "CONNECTION_FAILED" },
			],
			["rejected credentials", "input", { status: 401, bodyRaw: "" }],
			["an endpoint's 5xx", "transient", { status: 503, bodyRaw: "" }],
			["a body that is not JSON", "input", { status: 200, bodyRaw: "<html>" }],
			[
				"introspection disallowed",
				"policy",
				{
					status: 200,
					bodyRaw: JSON.stringify({
						errors: [{ message: "introspection is not allowed" }],
					}),
				},
			],
		])("%s is %s", async (_, failureClass, executed) => {
			const res = await call(executed);
			expect(res.structuredContent).toMatchObject({ error: { class: failureClass } });
		});

		test("refuses an answer over the limit before parsing it", async () => {
			const parse = vi.spyOn(JSON, "parse");
			try {
				const res = await call({
					status: 200,
					bodyRaw: "x".repeat(MAX_INTROSPECTION_BYTES + 1),
				});
				expect(res.isError).toBe(true);
				expect(firstText(res)).toMatch(/too large/);
				expect(parse).not.toHaveBeenCalled();
			} finally {
				parse.mockRestore();
			}
		});

		test("refuses a base64 body as not JSON, before measuring it", async () => {
			// Over the limit as text, so a size check that ran first would answer
			// "too large" about a length that is not the body's (#2458).
			const res = await call({
				status: 200,
				bodyEncoding: "base64",
				bodyRaw: "AAAA".repeat(MAX_INTROSPECTION_BYTES / 4 + 1),
			});
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not with JSON/);
		});

		test("refuses a base64 body that would parse as JSON text", async () => {
			// "1234" is valid base64 (three bytes that are not UTF-8) and a valid
			// JSON number, so only the encoding says it is no JSON document.
			const res = await call({ status: 200, bodyEncoding: "base64", bodyRaw: "1234" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not with JSON/);
		});

		test("refuses JSON that is not an introspection result, without echoing it", async () => {
			const res = await call({
				status: 200,
				bodyRaw: JSON.stringify({ data: { sentinel: "BODY-SENTINEL" } }),
			});
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not an introspection result/);
			expect(firstText(res)).not.toContain("BODY-SENTINEL");
		});

		test("names the OAuth 2.0 token when the engine could not get one", async () => {
			const res = await call({ status: 0, errorCode: "AUTH_FAILED", bodyRaw: "" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/OAuth 2\.0 token.*\(AUTH_FAILED\)/);
		});
	});

	test.each([
		[
			"both",
			{ requestId: "req_1", url: ENDPOINT },
			/"url" cannot be combined with "requestId"/,
		],
		["neither", {}, /Pass "requestId".*or "url"/],
		[
			"an inline header beside requestId",
			{ requestId: "req_1", headers: { A: "b" } },
			/"headers"/,
		],
	])("refuses %s before composing", async (_case, args, message) => {
		const client = fakeClient();
		const res = await dispatchTool("get_graphql_schema", args, ctxWith(client, ALLOWED));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(message);
		expect(client.composeRequest).not.toHaveBeenCalled();
	});
});
