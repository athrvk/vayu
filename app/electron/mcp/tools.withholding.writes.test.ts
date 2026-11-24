/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { buildSchema, introspectionFromSchema } from "graphql";
import { dispatchTool, MAX_INLINE_BODY_BYTES, TOOLS } from "./tools.js";
import type { McpSafetyConfig } from "./config.js";
import { EngineRequestError, type EngineClient } from "./engine-client.js";
import { REDACTED_MARKER } from "./withhold.js";
import { fakeClient, ctxWith, firstText, engineErrorBody } from "./tools.testkit.js";
import {
	REVEAL,
	read,
	RUN_SECRET,
	RUN_SECRET_CORES,
	runClient,
} from "./tools.withholding.testkit.js";

describe("secret withholding", () => {
	const EXAMPLES = [
		{
			id: "exa_1",
			requestId: "req_1",
			name: "200 OK",
			status: 200,
			headers: [
				{ key: "Set-Cookie", value: "session=example-session; HttpOnly", enabled: true },
				{ key: "Content-Type", value: "application/json", enabled: true },
			],
			body: "{}",
			contentType: "application/json",
			order: 0,
			origin: "user",
			bodyTruncated: false,
		},
	];

	test("list_request_examples withholds a Set-Cookie value and keeps the rest of the row", async () => {
		const client = fakeClient({ listRequestExamples: vi.fn().mockResolvedValue(EXAMPLES) });
		const { text, body } = await read("list_request_examples", client, undefined, {
			requestId: "req_1",
		});
		expect(text).not.toContain("example-session");
		expect(body.examples[0].headers).toEqual([
			{ key: "Set-Cookie", enabled: true, valueWithheld: true },
			{ key: "Content-Type", value: "application/json", enabled: true },
		]);
		expect(body.examples[0].body).toBe("{}");
		expect(body.examples[0].name).toBe("200 OK");
	});

	test("list_request_examples returns the headers as stored with reveal on", async () => {
		const client = fakeClient({ listRequestExamples: vi.fn().mockResolvedValue(EXAMPLES) });
		const { body } = await read("list_request_examples", client, REVEAL, {
			requestId: "req_1",
		});
		expect(body.examples).toEqual(EXAMPLES);
	});

	/*
	 * An example body is stored text an agent may read two ways, and both mask it
	 * (#3724). Mutation check: restore `callEngineStructured` with
	 * `boundExampleBodies(secretsShape(...)(rows))` in the list handler and the
	 * first two cases leak the secret.
	 */
	describe("list_request_examples masks a body as read_body does (#3724)", () => {
		const secretExample = (body: string) => ({
			...EXAMPLES[0],
			headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
			body,
		});
		const echoBody = () => JSON.stringify({ echoed: RUN_SECRET, region: "eu" });
		const exampleClient = () =>
			runClient({
				listRequestExamples: vi.fn().mockResolvedValue([secretExample(echoBody())]),
			});

		test("a secret variable's value reads <redacted>, as the same body through read_body", async () => {
			const client = exampleClient();
			const listed = await read("list_request_examples", client, undefined, {
				requestId: "req_1",
			});
			for (const leak of RUN_SECRET_CORES) expect(listed.text, leak).not.toContain(leak);
			const body = JSON.parse(listed.body.examples[0].body);
			expect(body).toEqual({ echoed: "<redacted>", region: "eu" });

			const paged = await read("read_body", client, undefined, {
				requestId: "req_1",
				exampleId: "exa_1",
			});
			expect(paged.body.text).toBe(listed.body.examples[0].body);
		});

		test("the mask runs before the cut, so a secret across the clip is not left as a prefix", async () => {
			const padded = secretExample(`${"x".repeat(MAX_INLINE_BODY_BYTES - 4)}${RUN_SECRET}`);
			const client = runClient({ listRequestExamples: vi.fn().mockResolvedValue([padded]) });
			const { body } = await read("list_request_examples", client, undefined, {
				requestId: "req_1",
			});
			const [row] = body.examples;
			expect(row.bodyClipped).toBe(true);
			for (const leak of RUN_SECRET_CORES) expect(row.body, leak).not.toContain(leak);
			// The marker is cut instead: the unmasked cut would end in "p@ss".
			expect(row.body).not.toContain("p@");
			expect(row.body.endsWith("<red")).toBe(true);
		});

		test("the value reads as stored with reveal on, and no masking lookup is made", async () => {
			const client = exampleClient();
			const { body } = await read("list_request_examples", client, REVEAL, {
				requestId: "req_1",
			});
			expect(body.examples[0].body).toBe(echoBody());
			expect(client.getGlobals).not.toHaveBeenCalled();
		});

		test("a failed masking lookup refuses the list whole, as read_body refuses", async () => {
			const client = runClient({
				getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
				listRequestExamples: vi.fn().mockResolvedValue([secretExample(echoBody())]),
			});
			for (const [tool, args] of [
				["list_request_examples", { requestId: "req_1" }],
				["read_body", { requestId: "req_1", exampleId: "exa_1" }],
			] as const) {
				const res = await dispatchTool(tool, args, ctxWith(client));
				expect(res.isError, tool).toBe(true);
				const text = firstText(res);
				expect(text, tool).toMatch(
					/masking .* could not complete, because the globals lookup/
				);
				for (const leak of RUN_SECRET_CORES) expect(text, leak).not.toContain(leak);
				expect(text, tool).not.toContain("exa_1");
			}
		});

		test("an unknown request is still the engine's not_found, naming the id", async () => {
			const client = runClient({
				listRequestExamples: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError(
							"404",
							404,
							engineErrorBody("not_found", "Request not found")
						)
					),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_9" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No request with id "req_9"');
			expect((res.structuredContent as { error: { class: string } }).error.class).toBe(
				"not_found"
			);
		});
	});

	// Writing does not grant reading: a write tool's answer echoes the stored
	// row, so it is withheld exactly as the read of that row is (#1809).
	const ECHO_ENVIRONMENT = {
		id: "env_1",
		name: "Staging",
		isActive: true,
		variables: { apiKey: { value: "echo-env-secret", secret: true, enabled: true } },
	};
	const ECHO_COLLECTION = {
		id: "c1",
		name: "API",
		variables: { pass: { value: "echo-collection-secret", secret: true, enabled: true } },
		auth: { mode: "bearer", token: "echo-collection-token" },
		openapi: { specId: "spec_1" },
	};
	const ECHO_REQUEST = {
		id: "req_1",
		collectionId: "c1",
		name: "Me",
		auth: { mode: "bearer", token: "echo-request-token" },
		headers: [{ key: "Authorization", value: "Bearer echo-request-header", enabled: true }],
		url: "https://echo-user:echo-request-password@api.example.com/x?api_key=echo-request-query",
		params: [{ key: "api_key", value: "echo-request-query", enabled: true }],
	};
	const ECHO_EXAMPLE = {
		id: "exa_1",
		requestId: "req_1",
		name: "200 OK",
		headers: [{ key: "Set-Cookie", value: "echo-example-cookie", enabled: true }],
	};
	const ECHO_GLOBALS = {
		id: "globals",
		variables: { token: { value: "echo-globals-secret", secret: true, enabled: true } },
	};

	interface WriteEcho {
		tool: string;
		args: Record<string, unknown>;
		/** The client method whose answer the tool hands back. */
		method: keyof EngineClient;
		answer: unknown;
		secrets: string[];
		/** Reads the tool makes before it writes. */
		reads?: Partial<EngineClient>;
	}

	const WRITE_ECHOES: WriteEcho[] = [
		{
			tool: "create_collection",
			args: { name: "API" },
			method: "createCollection",
			answer: ECHO_COLLECTION,
			secrets: ["echo-collection-secret", "echo-collection-token"],
		},
		{
			tool: "update_collection",
			args: { collectionId: "c1", name: "API" },
			method: "updateCollection",
			answer: ECHO_COLLECTION,
			secrets: ["echo-collection-secret", "echo-collection-token"],
		},
		{
			tool: "unbind_spec",
			args: { collectionId: "c1" },
			method: "updateCollection",
			answer: ECHO_COLLECTION,
			secrets: ["echo-collection-secret", "echo-collection-token"],
			reads: { getCollection: vi.fn().mockResolvedValue(ECHO_COLLECTION) },
		},
		{
			tool: "create_request",
			args: { collectionId: "c1", name: "Me", url: "https://api.example.com" },
			method: "createRequest",
			answer: ECHO_REQUEST,
			secrets: [
				"echo-request-token",
				"echo-request-header",
				"echo-request-password",
				"echo-request-query",
			],
		},
		{
			tool: "update_request",
			args: { requestId: "req_1", name: "Me" },
			method: "updateRequest",
			answer: ECHO_REQUEST,
			secrets: [
				"echo-request-token",
				"echo-request-header",
				"echo-request-password",
				"echo-request-query",
			],
		},
		{
			tool: "create_request_example",
			args: { requestId: "req_1", name: "200 OK" },
			method: "createRequestExample",
			answer: ECHO_EXAMPLE,
			secrets: ["echo-example-cookie"],
		},
		{
			tool: "update_request_example",
			args: { requestId: "req_1", exampleId: "exa_1", name: "200 OK" },
			method: "updateRequestExample",
			answer: ECHO_EXAMPLE,
			secrets: ["echo-example-cookie"],
		},
		{
			tool: "create_environment",
			args: { name: "Staging" },
			method: "createEnvironment",
			answer: ECHO_ENVIRONMENT,
			secrets: ["echo-env-secret"],
		},
		{
			tool: "update_environment",
			args: { environmentId: "env_1", name: "Staging" },
			method: "updateEnvironment",
			answer: ECHO_ENVIRONMENT,
			secrets: ["echo-env-secret"],
		},
		{
			tool: "activate_environment",
			args: { environmentId: "env_1" },
			method: "updateEnvironment",
			answer: ECHO_ENVIRONMENT,
			secrets: ["echo-env-secret"],
		},
		{
			tool: "activate_environment (none)",
			args: { environmentId: "none" },
			method: "updateEnvironment",
			answer: ECHO_ENVIRONMENT,
			secrets: ["echo-env-secret"],
			reads: { listEnvironments: vi.fn().mockResolvedValue([ECHO_ENVIRONMENT]) },
		},
		{
			tool: "update_globals",
			args: { variables: { region: "eu" } },
			method: "saveGlobals",
			answer: ECHO_GLOBALS,
			secrets: ["echo-globals-secret"],
		},
		{
			// The engine answers a restore with the trash entry alone; the
			// projection is what keeps a row it ever added from being echoed.
			tool: "restore_trash_entry",
			args: { entryId: "c1" },
			method: "restoreTrashEntry",
			answer: { id: "c1", kind: "collection", restored: true, auth: ECHO_COLLECTION.auth },
			secrets: ["echo-collection-token"],
		},
		{
			tool: "move_item",
			args: { type: "request", itemId: "req_1", collectionId: "c1" },
			method: "reorder",
			answer: { collections: [ECHO_COLLECTION], requests: [ECHO_REQUEST] },
			secrets: [
				"echo-collection-secret",
				"echo-collection-token",
				"echo-request-token",
				"echo-request-header",
				"echo-request-password",
				"echo-request-query",
			],
			reads: {
				listCollections: vi
					.fn()
					.mockResolvedValue([{ id: "c1", name: "API", parentId: "" }]),
				listRequests: vi.fn().mockResolvedValue([]),
			},
		},
	];

	const echoClient = ({ method, answer, reads }: WriteEcho) =>
		fakeClient({ ...reads, [method]: vi.fn().mockResolvedValue(answer) });

	const echoOf = async (echo: WriteEcho, safety: Partial<McpSafetyConfig>) => {
		const name = echo.tool.replace(/ \(none\)$/, "");
		const res = await dispatchTool(name, echo.args, ctxWith(echoClient(echo), safety));
		expect(res.isError).toBeFalsy();
		return { text: firstText(res), body: JSON.parse(firstText(res)) };
	};

	test.each(WRITE_ECHOES)("$tool withholds the echoed row's secrets by default", async (echo) => {
		const { text } = await echoOf(echo, { allowWrites: true });
		for (const secret of echo.secrets) expect(text).not.toContain(secret);
		expect(text).toMatch(/Withheld":true/);
	});

	test.each(WRITE_ECHOES)("$tool echoes the stored row whole with reveal on", async (echo) => {
		const { body } = await echoOf(echo, { allowWrites: true, ...REVEAL });
		expect(body).toEqual(echo.answer);
	});

	test("update_collection keeps the row's structure around what it withholds", async () => {
		const { body } = await echoOf(WRITE_ECHOES[1], { allowWrites: true });
		expect(body).toEqual({
			...ECHO_COLLECTION,
			variables: { pass: { enabled: true, secret: true, valueWithheld: true } },
			auth: { mode: "bearer", tokenWithheld: true },
		});
	});

	test("every write tool that answers a stored row is covered here", () => {
		const covered = new Set(WRITE_ECHOES.map((echo) => echo.tool.replace(/ \(none\)$/, "")));
		for (const name of [
			"create_collection",
			"update_collection",
			"create_request",
			"update_request",
			"create_request_example",
			"update_request_example",
			"create_environment",
			"update_environment",
			"activate_environment",
			"update_globals",
			"restore_trash_entry",
			"move_item",
			"unbind_spec",
		]) {
			expect(covered.has(name), name).toBe(true);
			expect(TOOLS.some((tool) => tool.name === name && tool.category === "write")).toBe(
				true
			);
		}
	});
});

/**
 * The `<redacted>` marker a run's record shows in place of a credential must not
 * come back as one (#3553). Written into a credential slot it would be stored,
 * or sent, as the credential itself. The slots are the ones a read withholds, so
 * a request body or a description holding the text is data in both modes, and
 * the whole check is off once the user has chosen to reveal secrets.
 */
describe("the redaction marker written as a credential (#3553)", () => {
	const OFF = { allowWrites: true, allowlist: ["api.example.com"] };
	const ON = { ...OFF, revealSecretsToAgents: true };
	const R = REDACTED_MARKER;
	const NEW_REQUEST = { collectionId: "c1", name: "Users", url: "https://api.example.com/users" };

	const storedRequest = (extra: Record<string, unknown> = {}) => ({
		getRequest: vi.fn().mockResolvedValue({
			id: "req_1",
			name: "Users",
			url: "https://api.example.com/users",
			headers: [],
			elements: [],
			updatedAt: 7,
			...extra,
		}),
	});
	const storedEnvironment = (variables: Record<string, unknown>) => ({
		getEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev", variables }),
	});
	const storedSecret = { token: { value: "t0k", enabled: true, secret: true } };

	interface MarkerCase {
		label: string;
		tool: string;
		args: Record<string, unknown>;
		/** What the refusal names. */
		names: string;
		/** The engine method the call reaches when it is let through. */
		reached: keyof EngineClient;
		/** Built per call: a mock shared across cases would carry the last one's calls. */
		seed?: () => Partial<Record<keyof EngineClient, unknown>>;
		/** Engine reads a refused call may still have made, because it needed the stored row. */
		reads?: string[];
	}

	const REFUSED: MarkerCase[] = [
		{
			label: "create_request auth.token",
			tool: "create_request",
			args: { ...NEW_REQUEST, auth: { mode: "bearer", token: R } },
			names: '"auth"',
			reached: "createRequest",
		},
		{
			label: "create_request oauth2 config.clientSecret",
			tool: "create_request",
			args: {
				...NEW_REQUEST,
				auth: { mode: "oauth2", config: { clientId: "app", clientSecret: R } },
			},
			names: '"auth"',
			reached: "createRequest",
		},
		{
			label: "create_request Authorization header",
			tool: "create_request",
			args: { ...NEW_REQUEST, headers: [{ key: "Authorization", value: R }] },
			names: '"Authorization" header',
			reached: "createRequest",
		},
		{
			label: "create_request header map",
			tool: "create_request",
			args: { ...NEW_REQUEST, headers: { "x-api-key": R } },
			names: '"x-api-key" header',
			reached: "createRequest",
		},
		{
			label: "create_request header named by the API-key auth",
			tool: "create_request",
			args: {
				...NEW_REQUEST,
				auth: { mode: "apikey", key: "X-Token", value: "{{k}}", in: "header" },
				headers: [{ key: "X-Token", value: R }],
			},
			names: '"X-Token" header',
			reached: "createRequest",
		},
		{
			label: "create_request ?access_token=",
			tool: "create_request",
			args: { ...NEW_REQUEST, url: `https://api.example.com/users?access_token=${R}` },
			names: '"access_token" parameter',
			reached: "createRequest",
		},
		{
			label: "create_request userinfo password",
			tool: "create_request",
			args: { ...NEW_REQUEST, url: `https://u:${R}@api.example.com/users` },
			names: "userinfo password",
			reached: "createRequest",
		},
		{
			label: "create_request fragment credential",
			tool: "create_request",
			args: { ...NEW_REQUEST, url: `https://api.example.com/users#page=2&signature=${R}` },
			names: '"signature" parameter',
			reached: "createRequest",
		},
		{
			label: "update_request auth",
			tool: "update_request",
			args: { requestId: "req_1", auth: { mode: "basic", username: "u", password: R } },
			names: '"auth"',
			reached: "updateRequest",
		},
		{
			label: "update_request Set-Cookie row",
			tool: "update_request",
			args: { requestId: "req_1", headers: [{ key: "Set-Cookie", value: R }] },
			names: '"Set-Cookie" header',
			reached: "updateRequest",
		},
		{
			label: "update_request URL",
			tool: "update_request",
			args: { requestId: "req_1", url: `https://api.example.com/users?api_key=${R}` },
			names: '"api_key" parameter',
			reached: "updateRequest",
		},
		{
			label: "update_request header the stored API-key auth names",
			tool: "update_request",
			args: { requestId: "req_1", headers: [{ key: "X-Token", value: R }] },
			names: '"X-Token" header',
			reached: "updateRequest",
			seed: () => storedRequest({ auth: { mode: "apikey", key: "X-Token", value: "{{k}}" } }),
			reads: ["getRequest"],
		},
		{
			label: "update_request URL the stored API-key auth names",
			tool: "update_request",
			args: { requestId: "req_1", url: `https://api.example.com/users?k=${R}` },
			names: '"k" parameter',
			reached: "updateRequest",
			seed: () =>
				storedRequest({ auth: { mode: "apikey", key: "k", value: "{{k}}", in: "query" } }),
			reads: ["getRequest"],
		},
		{
			label: "create_request_example Set-Cookie row",
			tool: "create_request_example",
			args: { requestId: "req_1", name: "200", headers: [{ key: "Set-Cookie", value: R }] },
			names: '"Set-Cookie" header',
			reached: "createRequestExample",
		},
		{
			label: "update_request_example Authorization row",
			tool: "update_request_example",
			args: { requestId: "req_1", exampleId: "ex_1", headers: { Authorization: R } },
			names: '"Authorization" header',
			reached: "updateRequestExample",
		},
		{
			label: "run_request Authorization header",
			tool: "run_request",
			args: {
				url: "https://api.example.com/x",
				headers: [{ name: "Authorization", value: R }],
			},
			names: '"Authorization" header',
			reached: "composeRequest",
		},
		{
			label: "run_request URL credential query",
			tool: "run_request",
			args: { url: `https://api.example.com/x?access_token=${R}` },
			names: "URL",
			reached: "composeRequest",
		},
		{
			label: "run_request header map",
			tool: "run_request",
			args: { url: "https://api.example.com/x", headers: { Cookie: R } },
			names: '"Cookie" header',
			reached: "composeRequest",
		},
		{
			label: "run_request auth",
			tool: "run_request",
			args: { url: "https://api.example.com/x", auth: { mode: "bearer", token: R } },
			names: '"auth"',
			reached: "composeRequest",
		},
		{
			label: "start_load_run header",
			tool: "start_load_run",
			args: {
				url: "https://api.example.com/x",
				headers: [{ name: "X-Auth-Token", value: R }],
			},
			names: '"X-Auth-Token" header',
			reached: "composeRequest",
		},
		{
			label: "get_graphql_schema header",
			tool: "get_graphql_schema",
			args: { url: "https://api.example.com/graphql", headers: { Authorization: R } },
			names: '"Authorization" header',
			reached: "composeRequest",
			seed: () => ({
				executeRequest: vi.fn().mockResolvedValue({
					status: 200,
					bodyRaw: JSON.stringify({
						data: introspectionFromSchema(buildSchema("type Query { id: ID }")),
					}),
				}),
			}),
		},
		{
			label: "create_environment secret",
			tool: "create_environment",
			args: { name: "Dev", variables: { token: { value: R, secret: true } } },
			names: 'secret variable "token"',
			reached: "createEnvironment",
		},
		{
			label: "update_environment secret",
			tool: "update_environment",
			args: { environmentId: "env_1", variables: { token: { value: R, secret: true } } },
			names: 'secret variable "token"',
			reached: "updateEnvironment",
			seed: () => storedEnvironment({}),
			reads: ["getEnvironment"],
		},
		{
			label: "update_environment bare string over a stored secret",
			tool: "update_environment",
			args: { environmentId: "env_1", variables: { token: R } },
			names: 'secret variable "token"',
			reached: "updateEnvironment",
			seed: () => storedEnvironment(storedSecret),
			reads: ["getEnvironment"],
		},
		{
			label: "update_environment value over a stored secret",
			tool: "update_environment",
			args: { environmentId: "env_1", variables: { token: { value: R } } },
			names: 'secret variable "token"',
			reached: "updateEnvironment",
			seed: () => storedEnvironment(storedSecret),
			reads: ["getEnvironment"],
		},
		{
			label: "update_globals secret",
			tool: "update_globals",
			args: { variables: { token: { value: R, secret: true } } },
			names: 'secret variable "token"',
			reached: "saveGlobals",
			reads: ["getGlobals"],
		},
		{
			label: "create_collection secret",
			tool: "create_collection",
			args: { name: "API", variables: { token: { value: R, secret: true } } },
			names: 'secret variable "token"',
			reached: "createCollection",
		},
		{
			label: "create_collection auth",
			tool: "create_collection",
			args: { name: "API", auth: { mode: "bearer", token: R } },
			names: '"auth"',
			reached: "createCollection",
		},
	];

	const engineMethodsCalled = (client: EngineClient) =>
		Object.entries(client as unknown as Record<string, unknown>)
			.filter(([, fn]) => vi.isMockFunction(fn) && fn.mock.calls.length > 0)
			.map(([name]) => name)
			.sort();

	const callWith = (testCase: MarkerCase, config: Partial<McpSafetyConfig>) => {
		const client = fakeClient(testCase.seed?.() as Partial<Record<keyof EngineClient, never>>);
		return dispatchTool(testCase.tool, testCase.args, ctxWith(client, config)).then((res) => ({
			res,
			client,
		}));
	};

	// Mutation check, per slot: drop the call that judges it (readAuthArg's
	// refuseRedactedAuth, refuseRedactedHeaders in the create, update, example and
	// override paths, refuseRedactedUrl, mergeVariables' refuseRedactedVariable)
	// and that slot's rows go red.
	test.each(REFUSED)("refuses $label while secrets are withheld", async (testCase) => {
		const { res, client } = await callWith(testCase, OFF);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(R);
		expect(firstText(res)).toContain(testCase.names);
		expect(firstText(res)).toContain("{{variable}} reference");
		expect(engineMethodsCalled(client)).toEqual(testCase.reads ?? []);
	});

	test.each(REFUSED)("accepts $label once reveal is on", async (testCase) => {
		const { res, client } = await callWith(testCase, ON);
		expect(res.isError).toBeFalsy();
		expect(client[testCase.reached]).toHaveBeenCalled();
	});

	describe.each([
		["withheld", OFF],
		["revealed", ON],
	])("what is not a credential slot, secrets %s", (_mode, config) => {
		const ACCEPTED: Array<[string, string, Record<string, unknown>, keyof EngineClient]> = [
			[
				"a body holding the text",
				"create_request",
				{ ...NEW_REQUEST, body: `{"token":"${R}"}`, bodyType: "json" },
				"createRequest",
			],
			[
				"a description holding the text",
				"update_request",
				{ requestId: "req_1", description: R },
				"updateRequest",
			],
			[
				"a body on update",
				"update_request",
				{ requestId: "req_1", body: R, bodyType: "text" },
				"updateRequest",
			],
			[
				"a header no read withholds",
				"create_request",
				{ ...NEW_REQUEST, headers: [{ key: "X-Trace-Id", value: R }] },
				"createRequest",
			],
			[
				"a credential header whose value only contains the text",
				"create_request",
				{ ...NEW_REQUEST, headers: [{ key: "Authorization", value: `Bearer ${R}` }] },
				"createRequest",
			],
			[
				"a query parameter no read withholds",
				"create_request",
				{ ...NEW_REQUEST, url: `https://api.example.com/users?page=${R}` },
				"createRequest",
			],
			[
				"a credential parameter whose value only contains the text",
				"create_request",
				{ ...NEW_REQUEST, url: `https://api.example.com/users?token=${R}x` },
				"createRequest",
			],
			[
				"a variable that is not a secret",
				"create_environment",
				{ name: "Dev", variables: { note: R, label: { value: R, secret: false } } },
				"createEnvironment",
			],
			[
				"a secret whose value only contains the text",
				"create_environment",
				{ name: "Dev", variables: { token: { value: `${R}!`, secret: true } } },
				"createEnvironment",
			],
			[
				"an auth credential written as a variable reference",
				"create_request",
				{ ...NEW_REQUEST, auth: { mode: "bearer", token: "{{token}}" } },
				"createRequest",
			],
		];

		test.each(ACCEPTED)("accepts %s", async (_label, tool, args, reached) => {
			const client = fakeClient();
			const res = await dispatchTool(tool, args, ctxWith(client, config));
			expect(res.isError).toBeFalsy();
			expect(client[reached]).toHaveBeenCalled();
		});
	});

	test("a kept row, as read with valueWithheld, is not judged by a value it does not carry", async () => {
		const client = fakeClient(
			storedRequest({
				headers: [{ key: "Authorization", value: "Bearer real", enabled: true }],
			})
		);
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", headers: [{ key: "Authorization", valueWithheld: true }] },
			ctxWith(client, OFF)
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toMatchObject({
			headers: [{ key: "Authorization", value: "Bearer real" }],
		});
	});

	test("a refused URL on update leaves the stored credentials unread and unwritten", async () => {
		const client = fakeClient(storedRequest({ url: "https://u:PW@h/x?api_key=S" }));
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", url: `https://u@h/x?api_key=${R}` },
			ctxWith(client, OFF)
		);
		expect(res.isError).toBe(true);
		expect(engineMethodsCalled(client)).toEqual([]);
	});
});
