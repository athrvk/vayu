/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools.testkit.ts
 * @brief What the `tools.*.test.ts` and `tools/*.tools.test.ts` files share: the
 *        fake engine client, the tool context, and the fixtures and schema
 *        walkers that more than one of them reads.
 */

import { expect, vi } from "vitest";
import { z } from "zod";
import {
	resolveDescription,
	TOOLS,
	type McpTool,
	type ToolContext,
	type ToolResult,
} from "./tools.js";
import type { McpHost } from "./tools/contract.js";
import { argumentsSchema, INPUT_REQUIRED } from "./tools/kit.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { EngineRequestError, type EngineClient } from "./engine-client.js";

/**
 * @p tool's description as a session under @p safety lists it - the defaults,
 * writes and reveal off, unless a case names otherwise. Throws for a missing
 * tool, so a renamed one fails here rather than passing a negative match.
 */
export function descriptionOf(
	tool: McpTool | undefined,
	safety: Partial<McpSafetyConfig> = {}
): string {
	if (!tool) throw new Error("tool is not registered");
	return resolveDescription(tool, resolveSafetyConfig(safety));
}

/** A node of an advertised (JSON Schema) output schema, as far as these tests walk it. */
export interface AdvertisedSchema {
	description?: string;
	properties?: Record<string, AdvertisedSchema>;
	items?: AdvertisedSchema;
	anyOf?: AdvertisedSchema[];
}

/** @p toolName's output schema as `tools/list` advertises it. */
export function advertisedOutputSchema(toolName: string): AdvertisedSchema {
	const outputSchema = TOOLS.find((t) => t.name === toolName)?.outputSchema;
	if (!outputSchema) throw new Error(`${toolName} declares no output schema`);
	return z.toJSONSchema(outputSchema, { io: "output" }) as AdvertisedSchema;
}

/** The members @p node declares: its own, or those of its object-shaped `anyOf` branches. */
export function declaredMembers(node: AdvertisedSchema): Record<string, AdvertisedSchema> {
	const branches = (node.anyOf ?? []).map((branch) => branch.properties ?? {});
	return Object.assign({}, node.properties, ...branches);
}

/**
 * The description @p toolName's output schema gives the member at @p path:
 * dotted property names, a `[]` suffix stepping into an array's items. Throws
 * for a member the schema does not declare, so a renamed field fails here.
 */
export function outputMemberDescription(toolName: string, path: string): string {
	let node = advertisedOutputSchema(toolName);
	for (const step of path.split(".")) {
		const name = step.replace(/\[\]$/, "");
		const member = declaredMembers(node)[name];
		if (!member) throw new Error(`${toolName}'s output schema declares no ${path}`);
		node = step.endsWith("[]") && member.items ? member.items : member;
	}
	return node.description ?? "";
}

/**
 * Every member path @p node declares: dotted names, `[]` stepping into an
 * array's items, an `anyOf` branch's members read as the node's own.
 */
export function declaredPaths(node: AdvertisedSchema, prefix = ""): string[] {
	return Object.entries(declaredMembers(node)).flatMap(([name, member]) => {
		const path = prefix ? `${prefix}.${name}` : name;
		const nested = member.items ? declaredPaths(member.items, `${path}[]`) : [];
		return [path, ...nested, ...declaredPaths(member, path)];
	});
}

/** Every member path @p value carries, spelled as {@link declaredPaths} spells them. */
export function presentPaths(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => presentPaths(item, `${prefix}[]`));
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([name, member]) => {
		const path = prefix ? `${prefix}.${name}` : name;
		return [path, ...presentPaths(member, path)];
	});
}

/**
 * Default `composeRequest` fake: the engine's identity composition for an
 * inline request with nothing to resolve - the request echoed back with the
 * environmentId attached. Composition *semantics* (variable resolution, the
 * inherit walk, by-id assembly) are engine-owned since #226 and tested by the
 * engine's request_composer_test.cpp plus the shared conformance fixture;
 * what these tests own is MCP's plumbing around the call: what reaches
 * `/compose`, that the allowlist gates on the *composed* URL, and that the
 * composed payload reaches `/execute` / `/runs` unchanged. Tests that need a
 * "resolved" or by-id result override this with a canned payload.
 */
export function identityCompose() {
	return vi.fn().mockImplementation((body: { request?: object; environmentId?: string }) => {
		const composed: Record<string, unknown> = { ...(body.request ?? {}) };
		if (typeof composed.method === "string") composed.method = composed.method.toUpperCase();
		if (body.environmentId !== undefined) composed.environmentId = body.environmentId;
		return Promise.resolve(composed);
	});
}

/**
 * The `{data, pagination}` envelope every paginated engine read answers with.
 * Written as a helper because the *pagination* block is what the bounded reads
 * disclose from - a fake returning a bare array would let a disclosure bug pass.
 */
export function page(data: unknown[], total = data.length, offset = 0) {
	return {
		data,
		pagination: {
			total,
			limit: data.length,
			offset,
			returned: data.length,
			hasMore: offset + data.length < total,
		},
	};
}

export const emptyPage = () => page([]);

/** @p envelope as a paged read answers its last page: `nextOffset` null, no `note`. */
export function lastPageAnswer(envelope: ReturnType<typeof page>) {
	return { ...envelope, pagination: { ...envelope.pagination, nextOffset: null } };
}

/**
 * A paged read's `pagination`, read from its one text block parsed as JSON,
 * after checking that parse agrees with `structuredContent`.
 */
export function pageOf(res: { content: Array<{ text: string }>; structuredContent?: unknown }) {
	const parsed = JSON.parse(res.content[0].text) as { pagination: Record<string, unknown> };
	expect(res.structuredContent).toEqual(parsed);
	return parsed.pagination;
}

/**
 * `serialize_token`'s shape (`engine/src/http/oauth_client.cpp`), bearer bytes
 * included - the fakes serve what the engine serves, so the tools' redaction
 * has something real to remove.
 */
export const OAUTH2_TOKEN_RECORD = {
	// Unit-separated, as `cache_key(config)` builds it engine-side.
	cacheKey:
		"https://id.example.com/oauth/token\u001fclient_a\u001fdefault\u001fclient_credentials\u001f",
	accessToken: "eyJhbGciOiJIUzI1NiJ9.thebearer.sig",
	tokenType: "Bearer",
	scope: "orders:read",
	expiresIn: 3600,
	createdAt: 1_755_000_000_000,
	expiresAt: 1_755_003_600_000,
	hasRefreshToken: true,
};

/**
 * An environments list holding `env_1`, for a test that scopes a send by it: a
 * send refuses an id no environment has (#2480). Inactive, so an omitted id
 * still composes with no environment.
 */
export const listingEnv1 = () =>
	vi.fn().mockResolvedValue([{ id: "env_1", name: "Staging", isActive: false }]);

/** Build a fake EngineClient with vi.fn()s for the methods under test. */
export function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
	return {
		health: vi.fn().mockResolvedValue({ status: "ok", version: "1.2.3" }),
		listCollections: vi.fn().mockResolvedValue([]),
		listCollectionsPage: vi.fn().mockResolvedValue(emptyPage()),
		listRequests: vi.fn().mockResolvedValue([]),
		listRequestsPage: vi.fn().mockResolvedValue(emptyPage()),
		listAllRequests: vi.fn().mockResolvedValue([]),
		listEnvironments: vi.fn().mockResolvedValue([]),
		listRuns: vi.fn().mockResolvedValue(emptyPage()),
		getRunReport: vi.fn().mockResolvedValue({ latency: {}, summary: {}, statusCodes: {} }),
		getRun: vi.fn().mockResolvedValue({
			id: "run_b",
			requestId: "req_1",
			baseline: false,
			type: "load",
			status: "completed",
			startTime: 1_755_000_000_000,
			configSnapshot: { url: "https://api.example.com/users", mode: "constant_rps" },
		}),
		exportRunReport: vi.fn().mockResolvedValue({
			text: '{"schema":"vayu.run-report"}',
			fileName: "Orders.run.json",
			mimeType: "application/json",
			notes: {},
		}),
		deleteRun: vi.fn().mockResolvedValue({ message: "Run deleted successfully" }),
		setRunBaseline: vi.fn().mockResolvedValue({ id: "run_b", baseline: true }),
		getRunSamples: vi.fn().mockResolvedValue(emptyPage()),
		getRunTimeSeries: vi.fn().mockResolvedValue(emptyPage()),
		getRunMonitorSeries: vi.fn().mockResolvedValue(emptyPage()),
		listBaselineRuns: vi
			.fn()
			.mockResolvedValue({ data: [{ id: "run_pinned", baseline: true }] }),
		composeRequest: identityCompose(),
		executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "running" }),
		stopRun: vi.fn().mockResolvedValue({ message: "Run stopped" }),
		getLiveMetricsSnapshot: vi
			.fn()
			.mockResolvedValue({ ticks: [{ currentRps: 100 }], completed: false }),
		consumeStreamEvents: vi
			.fn()
			.mockResolvedValue({ events: [], completed: true, capReached: false }),
		getConfig: vi.fn().mockResolvedValue({ entries: [{ key: "workers", value: "8" }] }),
		updateConfig: vi.fn().mockResolvedValue({ entries: [{ key: "workers", value: "16" }] }),
		createRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "New" }),
		getRequest: vi.fn().mockResolvedValue({
			id: "req_1",
			name: "Get users",
			method: "GET",
			url: "https://api.example.com/users",
			// Scripts ride here since issue #1514's cut-over; the row carries no
			// `preRequestScript` / `postRequestScript` column any more.
			elements: [],
		}),
		updateRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "Renamed" }),
		deleteRequest: vi.fn().mockResolvedValue({ message: "Request deleted successfully" }),
		listTrash: vi.fn().mockResolvedValue({ items: [], total: 0 }),
		listTrashPage: vi.fn().mockResolvedValue(emptyPage()),
		restoreTrashEntry: vi
			.fn()
			.mockResolvedValue({ id: "col_9", restored: true, reparentedToRoot: false }),
		purgeTrashEntry: vi.fn().mockResolvedValue({ id: "col_9", purged: true }),
		createCollection: vi.fn().mockResolvedValue({ id: "col_1", name: "API" }),
		updateCollection: vi.fn().mockResolvedValue({ id: "col_1", name: "Renamed" }),
		deleteCollection: vi.fn().mockResolvedValue({ message: "Collection deleted successfully" }),
		getCollection: vi.fn().mockResolvedValue({
			id: "col_1",
			name: "API",
			variables: { baseUrl: { value: "https://api.example.com", enabled: true } },
			auth: { mode: "none" },
			elements: [],
		}),
		getSpecMeta: vi.fn().mockResolvedValue({
			id: "spec_1",
			sourceUrl: "https://api.example.com/openapi.json",
			fetchedAt: 1_755_000_000_000,
			hash: "abc123",
			contentBytes: 4,
		}),
		getSpec: vi.fn().mockResolvedValue({
			id: "spec_1",
			content: "{ }\n",
			sourceUrl: "https://api.example.com/openapi.json",
			fetchedAt: 1_755_000_000_000,
			hash: "abc123",
			operations: null,
			responseSchemas: null,
		}),
		bindSpec: vi.fn().mockResolvedValue({
			specId: "spec_2",
			specHash: "def456",
			syncedAt: 1_755_000_100_000,
			stamped: 2,
			cleared: 0,
			unmatchedRequests: [],
			unmatchedOperations: [],
		}),
		importDocument: vi.fn().mockResolvedValue({
			idMap: { c1: "col_1", r1: "req_1" },
			meta: {
				format: "Postman Collection v2.1",
				requestCount: 2,
				folderCount: 1,
				environmentCount: 0,
				globalCount: 0,
				exampleCount: 0,
				skipped: [{ kind: "websocket", count: 1 }],
				nonExecutableAuth: 0,
				unattachedFileParts: 0,
			},
			collections: 2,
			requests: 2,
			environments: 0,
			globals: 0,
		}),
		exportSpec: vi.fn().mockResolvedValue({
			text: '{\n  "openapi": "3.1.0"\n}\n',
			fileName: "api.openapi.json",
			notes: { direction: "document", dialect: "OpenAPI 3.1.0", requestsExported: 2 },
		}),
		exportPostman: vi.fn().mockResolvedValue({
			text: '{\n  "info": { "name": "API" }\n}\n',
			fileName: "API.postman_collection.json",
			notes: {
				requestsExported: 2,
				foldersExported: 1,
				secretsOmitted: 1,
				notCarried: [{ code: "load-test", count: 1, message: "Load-test settings" }],
			},
		}),
		syncSpec: vi.fn().mockResolvedValue({
			idMap: {},
			specId: "spec_2",
			specHash: "def456",
			syncedAt: 1_755_000_100_000,
			created: 1,
			updated: 2,
			deleted: 0,
			skipped: { requests: 1, fields: 3, deletions: 1, declined: 2 },
		}),
		diffSpec: vi.fn().mockResolvedValue({
			identical: false,
			added: [
				{
					operation: { operationId: "listOwners", method: "GET", path: "/owners" },
					folder: "owners",
					draft: { name: "List owners", method: "GET", url: "{{baseUrl}}/owners" },
				},
			],
			declined: [
				{
					operation: {
						operationId: "getOwner",
						method: "GET",
						path: "/owners/{ownerId}",
					},
					folder: "owners",
					safe: false,
					draft: { name: "Get an owner", method: "GET", url: "{{baseUrl}}/owners/1" },
				},
			],
			removed: [
				{
					requestId: "req_9",
					name: "Delete a pet",
					operation: {
						operationId: "deletePet",
						method: "DELETE",
						path: "/pets/{petId}",
					},
				},
			],
			changed: [
				{
					requestId: "req_1",
					name: "List pets",
					boundOperation: { operationId: "listPets", method: "GET", path: "/pets" },
					operation: { operationId: "listPets", method: "GET", path: "/pets" },
					matchedBy: "operationId",
					renamed: false,
					previousUnknown: false,
					fields: [
						{
							field: "name",
							current: "List pets",
							next: "List all the pets",
							userTouched: false,
						},
					],
					draft: { name: "List all the pets", method: "GET", url: "{{baseUrl}}/pets" },
				},
			],
			unchanged: 12,
			unmapped: 1,
		}),
		listRequestExamples: vi.fn().mockResolvedValue([]),
		createRequestExample: vi
			.fn()
			.mockResolvedValue({ id: "exa_1", requestId: "req_1", name: "200 OK" }),
		updateRequestExample: vi
			.fn()
			.mockResolvedValue({ id: "exa_1", requestId: "req_1", name: "200 OK" }),
		deleteRequestExample: vi
			.fn()
			.mockResolvedValue({ message: "Example deleted successfully", id: "exa_1" }),
		reorder: vi.fn().mockResolvedValue({ collections: [], requests: [] }),
		getEnvironment: vi.fn().mockResolvedValue({
			id: "env_1",
			name: "Dev",
			variables: { baseUrl: { value: "x", enabled: true } },
		}),
		createEnvironment: vi
			.fn()
			.mockResolvedValue({ id: "env_2", name: "Staging", variables: {} }),
		updateEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev" }),
		deleteEnvironment: vi.fn().mockResolvedValue({ success: true }),
		getGlobals: vi.fn().mockResolvedValue({
			id: "globals",
			updatedAt: 1,
			variables: { region: { value: "eu", enabled: true } },
		}),
		saveGlobals: vi.fn().mockResolvedValue({ id: "globals", updatedAt: 2, variables: {} }),
		getCookies: vi.fn().mockResolvedValue({ scopes: [] }),
		getCookiesPage: vi.fn().mockResolvedValue(emptyPage()),
		clearCookies: vi.fn().mockResolvedValue({ cleared: 4 }),
		fetchOAuth2Token: vi.fn().mockResolvedValue(OAUTH2_TOKEN_RECORD),
		getOAuth2TokenStatus: vi
			.fn()
			.mockResolvedValue({ found: true, expired: false, token: OAUTH2_TOKEN_RECORD }),
		clearOAuth2Token: vi.fn().mockResolvedValue({ deleted: true }),
		startMockIssuer: vi.fn().mockResolvedValue({
			issuerId: "issuer_1",
			issuerUrl: "http://127.0.0.1:41234",
			tokenUrl: "http://127.0.0.1:41234/token",
			authorizeUrl: "http://127.0.0.1:41234/authorize",
			signingKey: "k3y",
		}),
		listMockIssuers: vi.fn().mockResolvedValue({ issuers: [] }),
		stopMockIssuer: vi.fn().mockResolvedValue({ stopped: true }),
		updateMockIssuer: vi.fn().mockResolvedValue({
			issuerId: "issuer_1",
			failureMode: "server_error",
			slowMs: 0,
		}),
		startMockServer: vi.fn().mockResolvedValue({
			mockId: "mock_1",
			collectionId: "col_1",
			collectionName: "API",
			url: "http://127.0.0.1:45010",
			port: 45010,
			latencyMs: 0,
			errorRatePct: 0,
			routeCount: 4,
			routesWithoutExample: 0,
			createdAt: "2026-08-18T09:00:00Z",
			allowedOrigins: [],
		}),
		listMockServers: vi.fn().mockResolvedValue({ data: [] }),
		getMockServerRoutes: vi.fn().mockResolvedValue({
			data: [
				{
					requestId: "req_1",
					requestName: "Get users",
					method: "GET",
					path: "/users",
					hasExample: true,
					status: 200,
				},
			],
		}),
		getMockServerActivity: vi.fn().mockResolvedValue({ data: [] }),
		stopMockServer: vi.fn().mockResolvedValue({ mockId: "mock_1", stopped: true }),
		startInbox: vi.fn().mockResolvedValue({
			inboxId: "inbox_1",
			url: "http://127.0.0.1:45001",
			bind: "127.0.0.1",
			port: 45001,
			running: true,
			loopback: true,
			captureCount: 0,
			allowedOrigins: [],
			response: { status: 200, body: "", headers: {}, delayMs: 0 },
		}),
		listInboxes: vi.fn().mockResolvedValue({
			data: [
				{
					inboxId: "inbox_1",
					url: "http://127.0.0.1:45001",
					port: 45001,
					running: true,
					loopback: true,
					captureCount: 3,
					allowedOrigins: [],
					response: { status: 200, body: "", headers: {}, delayMs: 0 },
				},
			],
		}),
		stopInbox: vi.fn().mockResolvedValue({ inboxId: "inbox_1", running: false }),
		deleteInbox: vi.fn().mockResolvedValue({ inboxId: "inbox_1", capturesDeleted: 3 }),
		getInboxCaptures: vi.fn().mockResolvedValue(emptyPage()),
		clearInboxCaptures: vi.fn().mockResolvedValue({ inboxId: "inbox_1", cleared: 3 }),
		updateInboxResponse: vi
			.fn()
			.mockResolvedValue({ inboxId: "inbox_1", response: { status: 503 } }),
		...overrides,
	} as unknown as EngineClient;
}

export function ctxWith(
	client: EngineClient,
	safety?: Partial<McpSafetyConfig>,
	host: McpHost = "app"
): ToolContext {
	return { client, config: resolveSafetyConfig(safety), host };
}

export const firstText = (r: { content: Array<{ text: string }> }) => r.content[0].text;

/** The engine's one error body shape, `{"error": {"code", "message"}}`. */
export const engineErrorBody = (code: string, message: string) =>
	JSON.stringify({ error: { code, message } });

/** A context whose client can put a question to the person and answered @p answers. */
export function ctxAsking(
	client: EngineClient,
	safety: Partial<McpSafetyConfig>,
	answers?: Record<string, unknown>
): ToolContext {
	return { ...ctxWith(client, safety), userInput: { responses: answers } };
}

/** The confirmation question a result asks the person, failing if it asks none. */
export function askedQuestion(result: ToolResult): string {
	const pending = INPUT_REQUIRED.get(result);
	expect(pending).toBeDefined();
	const request = pending?.inputRequests?.confirm as { params: { message: string } };
	return request.params.message;
}

/** The arguments one engine-client fake was called with. */
export function callArgs(fn: unknown, index = 0): unknown[] {
	return (fn as ReturnType<typeof vi.fn>).mock.calls[index];
}

/** The zod schema one tool declares for `field`. */
export function schemaOf(tool: string, field: string) {
	const found = TOOLS.find((t) => t.name === tool);
	expect(found, tool).toBeDefined();
	return found!.inputSchema[field] as z.ZodType;
}

/**
 * Parse through the tool's own `inputSchema` before dispatching, as the SDK
 * does in production: a test that hands `dispatchTool` the argument directly
 * passes even with the field removed from the schema and proves nothing.
 */
export const parseArgs = (name: string, args: Record<string, unknown>) =>
	argumentsSchema(
		TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>
	).parse(args);

// Canned engine output for composing req_1 by id: what
// request_composer_test.cpp proves the engine produces, `origin` stamps
// included (`emit_level`).
export const composedSavedRequest = {
	method: "POST",
	url: "https://api.example.com/users",
	headers: { "X-Api": "v1" },
	body: { mode: "json", content: '{"a":1}' },
	elements: [
		{
			id: "el_chain",
			kind: "script.post",
			enabled: true,
			config: { script: "pm.test('chain', function () {});" },
			origin: { kind: "collection", id: "col_1", name: "API" },
		},
		{
			id: "el_sig",
			kind: "script.pre",
			enabled: true,
			config: { script: "pm.request.headers['X-Sig'] = 'abc';" },
			origin: { kind: "request", id: "req_1" },
		},
		{
			id: "el_own",
			kind: "script.post",
			enabled: true,
			config: { script: "pm.test('own', function () {});" },
			origin: { kind: "request", id: "req_1" },
		},
	],
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	requestId: "req_1",
};

// The fake mirrors the engine's overlay rule: inline `request` fields lay
// over the stored request before the composed result comes back.
export const savedRequestClient = (composedOverrides: Record<string, unknown> = {}) =>
	fakeClient({
		listEnvironments: listingEnv1(),
		composeRequest: vi
			.fn()
			.mockImplementation(
				({ requestId, request }: { requestId?: string; request?: object }) =>
					requestId === "req_1"
						? Promise.resolve({
								...composedSavedRequest,
								...composedOverrides,
								...(request ?? {}),
							})
						: Promise.reject(new EngineRequestError("Engine responded 404", 404, ""))
			),
	});

/** Two catalogue entries in `GET /elements/kinds`'s shape. */
export const ELEMENT_KINDS = [
	{
		kind: "assert.status",
		category: "assert",
		phases: ["step.after"],
		label: "Status code",
		description: "Asserts the response status.",
		collectionOnly: false,
		configSchema: { type: "object", properties: { equals: { type: "integer" } } },
	},
	{
		kind: "timer.think",
		category: "timer",
		phases: ["step.after"],
		label: "Think time",
		description: "Pauses after the step.",
		collectionOnly: false,
		configSchema: { type: "object", properties: { ms: { type: "integer" } } },
	},
];

/** `GET /scripting/completions`' shape, Monaco's own keys included. */
export const SCRIPT_COMPLETIONS = {
	version: 2,
	engine: "0.0.0-test",
	completions: [
		{
			label: "pm.test",
			kind: 1,
			insertText: "pm.test()",
			detail: "pm.test(name: string, fn: () => void): typeof pm",
			documentation: "Define a test with assertions.",
		},
		{
			label: "pm.crypto.sha256",
			kind: 1,
			detail: "pm.crypto.sha256(data: string): string",
			documentation: "Synchronous SHA-256, hex encoded.",
		},
		{
			label: "btoa",
			kind: 1,
			documentation: "Base64-encodes a binary string, as for signing.",
		},
	],
};
