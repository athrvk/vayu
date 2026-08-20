/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	DEFAULT_INBOX_CAPTURE_LIMIT,
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	dispatchTool,
	INSECURE_TLS_REFUSAL,
	MAX_EXAMPLES_BODY_BYTES,
	MAX_INBOX_CAPTURE_LIMIT,
	MAX_IN_FLIGHT_BOUND,
	MAX_INLINE_BODY_BYTES,
	MAX_REDIRECTS_BOUND,
	MAX_REPORT_TRACE_BYTES,
	MAX_RUN_SERIES_LIMIT,
	MAX_SLOW_THRESHOLD_MS,
	MAX_SPEC_DIFF_ENTRIES,
	MAX_SUCCESS_SAMPLE_PERIOD,
	REQUEST_SETTINGS_KEYS,
	toolCatalog,
	TOOLS,
	type ToolContext,
} from "./tools.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import {
	DEFAULT_RUN_PAGE_LIMIT,
	EngineRequestError,
	EngineTimeoutError,
	MAX_ENGINE_PAGE_LIMIT,
	type EngineClient,
} from "./engine-client.js";
import { LOAD_TEST_LIMITS } from "@/constants/load-test";

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
function identityCompose() {
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
function page(data: unknown[], total = data.length, offset = 0) {
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

const emptyPage = () => page([]);

/**
 * `serialize_token`'s shape (`engine/src/http/oauth_client.cpp`), bearer bytes
 * included - the fakes serve what the engine serves, so the tools' redaction
 * has something real to remove.
 */
const OAUTH2_TOKEN_RECORD = {
	// Unit-separated, as `cache_key(config)` builds it engine-side.
	cacheKey: "https://id.example.com/oauth/token\u001fclient_a\u001fdefault\u001f",
	accessToken: "eyJhbGciOiJIUzI1NiJ9.thebearer.sig",
	tokenType: "Bearer",
	scope: "orders:read",
	expiresIn: 3600,
	createdAt: 1_755_000_000_000,
	expiresAt: 1_755_003_600_000,
	hasRefreshToken: true,
};

/** Build a fake EngineClient with vi.fn()s for the methods under test. */
function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
	return {
		health: vi.fn().mockResolvedValue({ status: "ok", version: "1.2.3" }),
		listCollections: vi.fn().mockResolvedValue([]),
		listRequests: vi.fn().mockResolvedValue([]),
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
		getLiveMetricsSnapshot: vi.fn().mockResolvedValue([{ currentRps: 100 }]),
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
		}),
		updateRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "Renamed" }),
		deleteRequest: vi.fn().mockResolvedValue({ message: "Request deleted successfully" }),
		createCollection: vi.fn().mockResolvedValue({ id: "col_1", name: "API" }),
		updateCollection: vi.fn().mockResolvedValue({ id: "col_1", name: "Renamed" }),
		deleteCollection: vi.fn().mockResolvedValue({ message: "Collection deleted successfully" }),
		getCollection: vi.fn().mockResolvedValue({
			id: "col_1",
			name: "API",
			variables: { baseUrl: { value: "https://api.example.com", enabled: true } },
			auth: { mode: "none" },
			preRequestScript: "",
			postRequestScript: "",
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
		exportSpec: vi.fn().mockResolvedValue({
			text: '{\n  "openapi": "3.1.0"\n}\n',
			fileName: "api.openapi.json",
			notes: { direction: "document", dialect: "OpenAPI 3.1.0", requestsExported: 2 },
		}),
		syncSpec: vi.fn().mockResolvedValue({
			idMap: {},
			specId: "spec_2",
			specHash: "def456",
			syncedAt: 1_755_000_100_000,
			created: 1,
			updated: 2,
			deleted: 0,
			skipped: { requests: 1, fields: 3, deletions: 1 },
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
		stopMockServer: vi.fn().mockResolvedValue({ mockId: "mock_1", stopped: true }),
		startInbox: vi.fn().mockResolvedValue({
			inboxId: "inbox_1",
			url: "http://127.0.0.1:45001",
			bind: "127.0.0.1",
			port: 45001,
			running: true,
			loopback: true,
			captureCount: 0,
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

function ctxWith(client: EngineClient, safety?: Partial<McpSafetyConfig>): ToolContext {
	return { client, config: resolveSafetyConfig(safety) };
}

const firstText = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe("tool registry", () => {
	test("exposes stable, unique tool names", () => {
		const names = TOOLS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain("run_request");
		expect(names).toContain("start_load_run");
		expect(names).toContain("compare_runs");
	});

	test("every tool has a valid category", () => {
		for (const t of TOOLS) {
			expect(["read", "execute", "write", "load"]).toContain(t.category);
		}
	});

	test("traffic-sending tools are 'execute', not 'write'", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		expect(byName.get("run_request")?.category).toBe("execute");
		expect(byName.get("run_collection_smoke")?.category).toBe("execute");
		// The 'write' category is reserved for data/config mutation.
		expect(byName.get("create_request")?.category).toBe("write");
		expect(byName.get("update_environment")?.category).toBe("write");
		expect(byName.get("update_engine_config")?.category).toBe("write");
	});

	test("the collection/request CRUD verbs are write-category, deletes hinted destructive", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		for (const name of [
			"create_collection",
			"update_collection",
			"delete_collection",
			"update_request",
			"delete_request",
		]) {
			expect(byName.get(name)?.category, name).toBe("write");
		}
		// The hint is what tells a client to treat the call as irreversible.
		expect(byName.get("delete_collection")?.annotations.destructiveHint).toBe(true);
		expect(byName.get("delete_request")?.annotations.destructiveHint).toBe(true);
	});

	test("toolCatalog mirrors the registry as IPC-safe metadata", () => {
		const catalog = toolCatalog();
		expect(catalog).toHaveLength(TOOLS.length);
		const get = catalog.find((t) => t.name === "get_engine_config");
		expect(get).toMatchObject({ category: "read" });
		const upd = catalog.find((t) => t.name === "update_engine_config");
		expect(upd).toMatchObject({ category: "write" });
		// Metadata only - no handler leaks across the boundary.
		expect(get).not.toHaveProperty("handler");
	});
});

describe("disabled tools", () => {
	test("a disabled tool is rejected by dispatch", async () => {
		const res = await dispatchTool(
			"get_engine_health",
			{},
			ctxWith(fakeClient(), { disabledTools: ["get_engine_health"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/disabled/i);
	});
});

describe("engine config tools", () => {
	test("get_engine_config passes the engine response through", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_engine_config", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("workers");
	});

	test("update_engine_config is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16" } },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateConfig).not.toHaveBeenCalled();
	});

	test("update_engine_config applies when writes are enabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateConfig).toHaveBeenCalledWith({ entries: { workers: "16" } }, undefined);
		const out = res.structuredContent as { changedKeys: string[]; restartRequired: string[] };
		expect(out.changedKeys).toEqual(["workers"]);
		expect(out.restartRequired).toEqual([]);
	});

	test("update_engine_config flags restart-required keys from the engine's read-back", async () => {
		const client = fakeClient({
			getConfig: vi.fn().mockResolvedValue({
				entries: [
					// A key the engine really does read once, when it opens the
					// database. `workers` used to stand here and stopped being
					// restart-gated in #873 - the run reads it - so the example
					// moved rather than teaching the next reader the old claim.
					{
						key: "dbCacheSize",
						value: "67108864",
						label: "Database Cache Size",
						requiresRestart: true,
					},
					{
						key: "timeoutMs",
						value: "5000",
						label: "Request timeout",
						requiresRestart: false,
					},
				],
			}),
		});
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { dbCacheSize: "67108864", timeoutMs: "5000" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const out = res.structuredContent as { changedKeys: string[]; restartRequired: string[] };
		expect(out.changedKeys.sort()).toEqual(["dbCacheSize", "timeoutMs"]);
		expect(out.restartRequired).toEqual(["dbCacheSize"]);
		// The human-readable text warns about the restart.
		expect(firstText(res)).toMatch(/restart required/i);
	});
});

describe("data-write tools", () => {
	test("create_request is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "New", url: "https://api.example.com" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	test("create_request builds the payload (headers/body) when writes are enabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "New",
				url: "https://api.example.com/x",
				method: "POST",
				headers: { "X-A": "1" },
				body: '{"a":1}',
				bodyType: "json",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			collectionId: "c1",
			name: "New",
			method: "POST",
			url: "https://api.example.com/x",
			headers: [{ key: "X-A", value: "1", enabled: true }],
			// Canonical body shape keys off `mode` (round-trips with the app).
			body: { mode: "json", content: '{"a":1}' },
		});
		// The engine assigns ids and answers a create carrying one with a 400
		// (#97). toMatchObject above ignores extra keys, so the absence has to be
		// asserted outright - including an `id: undefined` that would serialize
		// to `"id": null` and be rejected just the same.
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	/*
	 * Stored pre/post-request scripts through the CRUD tools (#419). An agent
	 * could already *run* a script ad hoc through `run_request` but could not
	 * persist one onto the request it had just created, so scripts travelled in
	 * the description for a human to paste into the Pre-request or Tests tab.
	 *
	 * These are the whole contract: written verbatim on create, patched one at a
	 * time on update, and cleared by an explicit empty string - which works only
	 * because the engine's merge-patch tells absent and `""` apart. Drop the
	 * field mapping and every one of them reddens.
	 */
	test("create_request stores the pre-request and test scripts verbatim", async () => {
		const client = fakeClient();
		const pre = "pm.request.headers.add({ key: 'X-Sig', value: pm.variables.get('sig') });";
		const post = "pm.test('ok', () => pm.response.to.have.status(200));";
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Signed",
				url: "https://api.example.com/x",
				preRequestScript: pre,
				postRequestScript: post,
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({ preRequestScript: pre, postRequestScript: post });
	});

	test("create_request sends no script key when the caller named none", async () => {
		// The engine defaults an absent field to empty on a create; sending `""`
		// anyway would make the payload claim the agent asked for a blank script.
		const client = fakeClient();
		await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "Plain", url: "https://api.example.com/x" },
			ctxWith(client, { allowWrites: true })
		);
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(Object.keys(payload as object)).not.toContain("preRequestScript");
		expect(Object.keys(payload as object)).not.toContain("postRequestScript");
	});

	test("update_request patches one script and keeps the other stored", async () => {
		const client = fakeClient();
		const post = "pm.test('created', () => pm.response.to.have.status(201));";
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", postRequestScript: post },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		// Absent keeps: a `preRequestScript: ""` filler here would blank a signing
		// script the caller never mentioned. Also proves a script alone satisfies
		// the empty-patch refusal, which counts the payload's keys.
		expect(payload).toEqual({ postRequestScript: post });
	});

	test("update_request clears a script when passed an empty string", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", preRequestScript: "" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		// `""` is a value the merge-patch stores, not an omission - the difference
		// between "leave my script alone" and "delete it".
		expect(payload).toEqual({ preRequestScript: "" });
	});

	test("the CRUD tools name a stored script once, without the run tools' alias", () => {
		// `tests` is the engine's spelling for an ad-hoc run body; a second name
		// for a stored field would be a second name to keep in step.
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		for (const name of ["create_request", "update_request"]) {
			const schema = byName.get(name)?.inputSchema;
			expect(schema, name).toBeDefined();
			expect(Object.keys(schema!), name).toEqual(
				expect.arrayContaining(["preRequestScript", "postRequestScript"])
			);
			expect(Object.keys(schema!), name).not.toContain("tests");
		}
	});

	/*
	 * Collection + request CRUD (#378). The write surface used to be create-only,
	 * so an agent could file a request into a collection a human had made and
	 * could never correct or remove it. These cover the two things that make the
	 * new verbs safe to hand an agent: a patch carries only what the caller named
	 * (the engine merge-patches, so anything extra is a field silently rewritten),
	 * and a delete cannot happen without the user seeing what it destroys.
	 */
	test("every new write verb refuses before touching the engine when writes are off", async () => {
		const client = fakeClient();
		const calls: Array<[string, Record<string, unknown>, keyof EngineClient]> = [
			["create_collection", { name: "API" }, "createCollection"],
			["update_collection", { collectionId: "col_1", name: "API" }, "updateCollection"],
			["delete_collection", { collectionId: "col_1", confirmed: true }, "deleteCollection"],
			["update_request", { requestId: "req_1", name: "x" }, "updateRequest"],
			["delete_request", { requestId: "req_1", confirmed: true }, "deleteRequest"],
		];
		for (const [tool, args, method] of calls) {
			const res = await dispatchTool(tool, args, ctxWith(client, { allowWrites: false }));
			expect(res.isError, tool).toBe(true);
			expect(client[method], tool).not.toHaveBeenCalled();
		}
		// A delete must not even read what it would destroy while writes are off.
		expect(client.listCollections).not.toHaveBeenCalled();
		expect(client.getRequest).not.toHaveBeenCalled();
	});

	test("create_collection sends the stated fields and lets the engine assign the id", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{ name: "API", parentId: "col_root", description: "Public endpoints" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toEqual({
			name: "API",
			parentId: "col_root",
			description: "Public endpoints",
		});
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	test("create_collection omits parentId entirely for a top-level collection", async () => {
		// A `parentId: undefined` serializes to `"parentId": null`, which the
		// engine reads as an explicit reset rather than "not stated".
		const client = fakeClient();
		await dispatchTool(
			"create_collection",
			{ name: "API" },
			ctxWith(client, { allowWrites: true })
		);
		const payload = (client.createCollection as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(Object.keys(payload as object)).toEqual(["name"]);
	});

	test("update_collection patches only what the caller named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateCollection as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("col_1");
		expect(payload).toEqual({ name: "Renamed" });
	});

	test("update_collection refuses a patch that names nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_collection",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
	});

	test("update_request patches only the named field, leaving the rest stored", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("req_1");
		// `PUT /requests/:id` merge-patches: a defaulted method or an empty header
		// list here would blank a field the caller never mentioned.
		expect(payload).toEqual({ name: "Renamed" });
	});

	test("update_request writes the body blob and its denormalized type together", async () => {
		const client = fakeClient();
		await dispatchTool(
			"update_request",
			{ requestId: "req_1", body: "a=1&b=2", bodyType: "x-www-form-urlencoded" },
			ctxWith(client, { allowWrites: true })
		);
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({
			body: {
				mode: "x-www-form-urlencoded",
				fields: [
					{ key: "a", value: "1", enabled: true },
					{ key: "b", value: "2", enabled: true },
				],
			},
			bodyType: "x-www-form-urlencoded",
		});
	});

	test("update_request refuses a bodyType with no body to describe", async () => {
		// Writing the column without the blob leaves the two disagreeing about
		// what the request sends.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", bodyType: "json" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request refuses a patch with no fields at all", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_environment sends no body id - the path is the identity", async () => {
		// A body id that disagrees with the path is a 400 since #97, and one that
		// agrees is dead weight. Same reason the renderer's PUT sends a patch only.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "secret" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("env_1");
		expect(Object.keys(payload as object)).not.toContain("id");
	});

	test("update_environment merges variables and preserves the existing name", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "secret" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// PUT /environments/:id - the id is the path argument, not a body field.
		const call = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("env_1");
		const payload = call[1];
		expect(payload).not.toHaveProperty("id");
		expect(payload).toMatchObject({
			name: "Dev",
			variables: {
				baseUrl: { value: "x", enabled: true },
				apiKey: { value: "secret", enabled: true },
			},
		});
	});

	test("update_environment overwrites the value and keeps secret/type/createdAt", async () => {
		// A secret-marked token rotated through MCP must stay masked: the engine
		// replaces the variables blob wholesale, so whatever this payload drops
		// is gone for good and the popover renders the token in plaintext.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					apiKey: {
						value: "old",
						enabled: true,
						secret: true,
						type: "string",
						createdAt: 42,
					},
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: "rotated" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(payload).toMatchObject({
			variables: {
				apiKey: {
					value: "rotated",
					enabled: true,
					secret: true,
					type: "string",
					createdAt: 42,
				},
			},
		});
	});

	test("update_environment does not re-enable a disabled variable", async () => {
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: { host: { value: "old", enabled: false } },
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { host: "new" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		expect(payload).toMatchObject({ variables: { host: { value: "new", enabled: false } } });
	});

	test("update_environment gives a new key a sane default entry", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { brandNew: "v" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const entry = (payload as { variables: Record<string, unknown> }).variables.brandNew;
		expect(entry).toEqual({ value: "v", enabled: true });
	});

	test("update_environment replaces a malformed stored entry instead of spreading it", async () => {
		// A bare string off disk is a real case (D17). Spreading it would write
		// `{0:"o",1:"l",...}` into the blob every reader then has to survive.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: { loose: "old", listy: ["a"] },
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { loose: "new", listy: "new" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.updateEnvironment as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const vars = (payload as { variables: Record<string, unknown> }).variables;
		expect(vars.loose).toEqual({ value: "new", enabled: true });
		expect(vars.listy).toEqual({ value: "new", enabled: true });
	});

	test("update_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { a: "b" } },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});
});

/**
 * State CRUD parity (#758): the environment lifecycle, the globals singleton
 * and the cookie jar.
 *
 * What is worth locking here is what the *blob* rule makes fragile. Every write
 * in this family replaces a whole JSON object engine-side, so each of these
 * tools is a read-merge-write, and every one of them can silently destroy a
 * flag, a value or a whole variable by merging wrong. The rest is the shape of
 * the two calls the engine has no verb for: activation (one PUT, no companion
 * write) and the three cookie scopes (absent, null and an id are three
 * different calls).
 */
describe("environments, globals and the cookie jar", () => {
	const WRITES = { allowWrites: true };
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");
	const varsOf = (payload: unknown) =>
		(payload as { variables: Record<string, unknown> }).variables;
	const lastCall = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls[0];

	test("update_environment sets flags and keeps the ones it was not asked about", async () => {
		// The #314 invariant extended to the object form: `type` and `enabled`
		// arrive, `value`, `secret` and `createdAt` survive untouched. Drop the
		// stored spread from the merge and this reads back a plaintext token.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					apiKey: { value: "old", enabled: true, secret: true, createdAt: 42 },
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKey: { type: "string", enabled: false } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.updateEnvironment)[1]).apiKey).toEqual({
			value: "old",
			enabled: false,
			secret: true,
			type: "string",
			createdAt: 42,
		});
	});

	test("update_environment removes a variable rather than blanking it", async () => {
		// The gap this closes: writing "" leaves the name resolving to an empty
		// string, which is not the same as the name not being there.
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Dev",
				variables: {
					keep: { value: "a", enabled: true },
					drop: { value: "b", enabled: true },
				},
			}),
		});
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", removeVariables: ["drop"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const written = varsOf(lastCall(client.updateEnvironment)[1]);
		expect(Object.keys(written)).toEqual(["keep"]);
		expect(written).not.toHaveProperty("drop");
	});

	test("update_environment says which names it found nothing to remove for", async () => {
		// Not an error - a retried call whose first attempt landed would fail on
		// its own success - but not silent either, or a typo reads as a removal.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", removeVariables: ["ghost"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(allText(res)).toContain("ghost");
		expect(client.updateEnvironment).toHaveBeenCalled();
	});

	test("update_environment refuses a name that is both set and removed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { token: "v" }, removeVariables: ["token"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment refuses to flag a variable that has no value yet", async () => {
		// `{secret: true}` against a mistyped name would otherwise create an empty
		// secret variable and report success.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", variables: { apiKeey: { secret: true } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("apiKeey");
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment refuses a call with nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("update_environment renames without disturbing the variables", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_environment",
			{ environmentId: "env_1", name: "Development" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(lastCall(client.updateEnvironment)[1]).toEqual({
			name: "Development",
			variables: { baseUrl: { value: "x", enabled: true } },
		});
	});

	test("create_environment stores variables as entries and lets the engine assign the id", async () => {
		// A body `id` is a 400 since #97, so the tool offers no field for one and
		// a caller that invents one has it dropped rather than forwarded.
		const client = fakeClient();
		const res = await dispatchTool(
			"create_environment",
			{
				id: "env_mine",
				name: "Staging",
				description: "pre-prod",
				variables: { host: "stg.example.com", token: { value: "t", secret: true } },
			},
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const payload = lastCall(client.createEnvironment)[0];
		expect(payload).not.toHaveProperty("id");
		expect(payload).toEqual({
			name: "Staging",
			description: "pre-prod",
			variables: {
				host: { value: "stg.example.com", enabled: true },
				token: { value: "t", enabled: true, secret: true },
			},
		});
	});

	test("create_environment refuses a variable with no value", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_environment",
			{ name: "Staging", variables: { token: { secret: true } } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.createEnvironment).not.toHaveBeenCalled();
	});

	test("create_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool("create_environment", { name: "Staging" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.createEnvironment).not.toHaveBeenCalled();
	});

	test("activate_environment is one PUT carrying only the flag", async () => {
		// The engine deactivates the previous row in the same transaction, so a
		// companion write would be a second definition of the same rule - and a
		// `name` would be a rename nobody asked for.
		const client = fakeClient();
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "env_2" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateEnvironment).toHaveBeenCalledTimes(1);
		expect(lastCall(client.updateEnvironment)).toEqual([
			"env_2",
			{ isActive: true },
			undefined,
		]);
	});

	test('activate_environment "none" deactivates whichever environment holds the flag', async () => {
		// There is no "no environment" row to write true to, so the id has to be
		// read - which is why this direction costs a list read the other does not.
		const client = fakeClient({
			listEnvironments: vi.fn().mockResolvedValue([
				{ id: "env_1", name: "Dev", isActive: false },
				{ id: "env_2", name: "Prod", isActive: true },
			]),
		});
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "none" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(lastCall(client.updateEnvironment)).toEqual([
			"env_2",
			{ isActive: false },
			undefined,
		]);
	});

	test('activate_environment "none" writes nothing when nothing is active', async () => {
		const client = fakeClient({
			listEnvironments: vi.fn().mockResolvedValue([{ id: "env_1", isActive: false }]),
		});
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "none" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("No environment was active");
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("activate_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"activate_environment",
			{ environmentId: "env_2" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.updateEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment previews with the name and variable count, and deletes nothing", async () => {
		const client = fakeClient({
			getEnvironment: vi.fn().mockResolvedValue({
				id: "env_1",
				name: "Prod",
				isActive: true,
				variables: { a: { value: "1" }, b: { value: "2" }, c: { value: "3" } },
			}),
		});
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("Prod");
		expect(firstText(res)).toContain("3 variables");
		expect(firstText(res)).toContain("currently active");
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment deletes once confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1", confirmed: true },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteEnvironment).toHaveBeenCalledWith("env_1", undefined);
	});

	test("delete_environment refuses an id no environment has", async () => {
		// `getEnvironment` resolves from the list, so a miss is null rather than a
		// 404 - and deleting blind on a null would confirm against nothing.
		const client = fakeClient({ getEnvironment: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_gone", confirmed: true },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("delete_environment is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_environment",
			{ environmentId: "env_1", confirmed: true },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.getEnvironment).not.toHaveBeenCalled();
		expect(client.deleteEnvironment).not.toHaveBeenCalled();
	});

	test("update_globals merges into the stored singleton", async () => {
		// `POST /globals` replaces the blob whole - it is the resource with no
		// create/update split - so without the read this write deletes `region`.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ variables: { traceId: "abc" } },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.saveGlobals)[0])).toEqual({
			region: { value: "eu", enabled: true },
			traceId: { value: "abc", enabled: true },
		});
	});

	test("update_globals removes a global rather than blanking it", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ removeVariables: ["region"] },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(varsOf(lastCall(client.saveGlobals)[0])).toEqual({});
	});

	test("update_globals refuses a call with nothing to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool("update_globals", {}, ctxWith(client, WRITES));
		expect(res.isError).toBe(true);
		expect(client.saveGlobals).not.toHaveBeenCalled();
	});

	test("update_globals is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_globals",
			{ variables: { a: "b" } },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.saveGlobals).not.toHaveBeenCalled();
	});

	test("clear_cookies distinguishes every jar, one environment's, and the unnamed one", async () => {
		// Three calls, not two: the engine reads an absent parameter as "all" and
		// a present-but-empty one as the no-environment jar, so collapsing null
		// into undefined would clear every session in the app instead of one.
		const all = fakeClient();
		expect((await dispatchTool("clear_cookies", {}, ctxWith(all, WRITES))).isError).toBeFalsy();
		expect(lastCall(all.clearCookies)).toEqual([undefined, undefined]);

		const scoped = fakeClient();
		expect(
			(
				await dispatchTool(
					"clear_cookies",
					{ environmentId: "env_1" },
					ctxWith(scoped, WRITES)
				)
			).isError
		).toBeFalsy();
		expect(lastCall(scoped.clearCookies)).toEqual(["env_1", undefined]);

		const unnamed = fakeClient();
		expect(
			(await dispatchTool("clear_cookies", { environmentId: null }, ctxWith(unnamed, WRITES)))
				.isError
		).toBeFalsy();
		expect(lastCall(unnamed.clearCookies)).toEqual([null, undefined]);
	});

	test("clear_cookies is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool("clear_cookies", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.clearCookies).not.toHaveBeenCalled();
	});

	test("get_globals and get_cookies read without a gate", async () => {
		const client = fakeClient();
		expect((await dispatchTool("get_globals", {}, ctxWith(client))).isError).toBeFalsy();
		expect((await dispatchTool("get_cookies", {}, ctxWith(client))).isError).toBeFalsy();
		expect(client.getGlobals).toHaveBeenCalled();
		expect(client.getCookies).toHaveBeenCalled();
	});
});

/**
 * The delete gate (#378). `delete_collection` is the most destructive call in
 * the app - it cascades through every descendant collection and every request
 * inside them - so the write toggle alone is not its gate: it also asks, with
 * the real counts read from the engine, the way `start_load_run` asks before
 * generating traffic.
 */
describe("destructive deletes ask first", () => {
	/** A three-deep subtree under col_1, plus an unrelated collection beside it. */
	const TREE = [
		{ id: "col_1", name: "API", parentId: "" },
		{ id: "col_2", name: "v1", parentId: "col_1" },
		{ id: "col_3", name: "users", parentId: "col_2" },
		{ id: "col_other", name: "Elsewhere", parentId: "" },
	];

	/** 2 + 1 + 0 inside the subtree; the 5 outside it must never be counted. */
	const REQUESTS: Record<string, unknown[]> = {
		col_1: [{ id: "r1" }, { id: "r2" }],
		col_2: [{ id: "r3" }],
		col_3: [],
		col_other: [{ id: "r4" }, { id: "r5" }, { id: "r6" }, { id: "r7" }, { id: "r8" }],
	};

	function treeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listCollections: vi.fn().mockResolvedValue(TREE),
			listRequests: vi
				.fn()
				.mockImplementation((id: string) => Promise.resolve(REQUESTS[id] ?? [])),
			...overrides,
		});
	}

	/** A context whose client answers elicitation with `outcome`. */
	function ctxElicits(
		client: EngineClient,
		outcome: { action: string; content?: Record<string, unknown> }
	): ToolContext {
		return {
			...ctxWith(client, { allowWrites: true }),
			elicit: vi.fn().mockResolvedValue(outcome),
		};
	}

	test("delete_collection previews the real subtree counts and deletes nothing", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		// Counted, not guessed: 2 descendants and the 3 requests inside the
		// subtree - never the 5 that live in the collection beside it.
		expect(firstText(res)).toContain("2 sub-collection(s)");
		expect(firstText(res)).toContain("3 saved request(s)");
		expect(firstText(res)).toContain("API");
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection deletes on the confirmed flag and reports what went", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteCollection).toHaveBeenCalledWith("col_1", undefined);
		expect(res.content.map((c) => c.text).join("\n")).toContain("2 sub-collection(s)");
	});

	test("delete_collection takes elicitation as the confirmation", async () => {
		const client = treeClient();
		const ctx = ctxElicits(client, { action: "accept", content: { proceed: true } });
		// No `confirmed` flag - the human answered the prompt instead.
		const res = await dispatchTool("delete_collection", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).not.toMatch(/awaiting confirmation/i);
		expect(client.deleteCollection).toHaveBeenCalledTimes(1);
		const prompt = (ctx.elicit as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			message: string;
		};
		// The person answering sees the counts, not just an id.
		expect(prompt.message).toContain("2 sub-collection(s)");
		expect(prompt.message).toContain("3 saved request(s)");
	});

	test("a declined prompt deletes nothing, even with the flag set", async () => {
		const client = treeClient();
		const ctx = ctxElicits(client, { action: "accept", content: { proceed: false } });
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/declined/i);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection refuses an id the engine does not have", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_missing", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("col_missing");
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_collection refuses when the subtree cannot be read", async () => {
		// A count nobody could verify must not become a prompt the user answers.
		const client = treeClient({
			listRequests: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("delete_request names the request in its preview and deletes nothing", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(firstText(res)).toContain("Get users");
		expect(firstText(res)).toContain("https://api.example.com/users");
		expect(client.deleteRequest).not.toHaveBeenCalled();
	});

	test("delete_request deletes once confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_1", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteRequest).toHaveBeenCalledWith("req_1", undefined);
	});

	test("delete_request answers a missing id as such, not as a transport failure", async () => {
		const client = fakeClient({
			getRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "not found")
				),
		});
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_gone", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("req_gone");
		expect(client.deleteRequest).not.toHaveBeenCalled();
	});
});

/**
 * The whole point of #378, as one sequence: an agent sets up a collection, files
 * a request in it, corrects the request, and cleans both up - without a human
 * touching the UI. Each step feeds the next the id the engine assigned, which is
 * what the create-only surface could not do.
 */
describe("an agent can round-trip its own work", () => {
	test("create a collection, fill it, correct it, delete both", async () => {
		const created = { id: "col_new", name: "Checkout API", parentId: "" };
		const client = fakeClient({
			createCollection: vi.fn().mockResolvedValue(created),
			createRequest: vi.fn().mockResolvedValue({
				id: "req_new",
				name: "POST /orders",
				collectionId: created.id,
			}),
			getRequest: vi
				.fn()
				.mockResolvedValue({ id: "req_new", name: "POST /orders", method: "POST" }),
			listCollections: vi.fn().mockResolvedValue([created]),
			listRequests: vi.fn().mockResolvedValue([]),
		});
		const ctx = ctxWith(client, { allowWrites: true });

		const collection = await dispatchTool("create_collection", { name: "Checkout API" }, ctx);
		expect(collection.isError).toBeFalsy();
		const collectionId = (JSON.parse(firstText(collection)) as { id: string }).id;

		const request = await dispatchTool(
			"create_request",
			{ collectionId, name: "POST /orders", url: "https://api.example.com/orders" },
			ctx
		);
		expect(request.isError).toBeFalsy();
		const requestId = (JSON.parse(firstText(request)) as { id: string }).id;

		const corrected = await dispatchTool(
			"update_request",
			{ requestId, url: "https://api.example.com/v2/orders" },
			ctx
		);
		expect(corrected.isError).toBeFalsy();
		expect((client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(requestId);

		const removedRequest = await dispatchTool(
			"delete_request",
			{ requestId, confirmed: true },
			ctx
		);
		expect(removedRequest.isError).toBeFalsy();
		expect(client.deleteRequest).toHaveBeenCalledWith(requestId, undefined);

		const removedCollection = await dispatchTool(
			"delete_collection",
			{ collectionId, confirmed: true },
			ctx
		);
		expect(removedCollection.isError).toBeFalsy();
		expect(client.deleteCollection).toHaveBeenCalledWith(collectionId, undefined);
	});
});

/*
 * Document CRUD parity (#759). What an agent could *write* onto a saved
 * document used to be a fraction of what the app stores: no auth, none of the
 * Settings tab, no examples at all, and a collection's variables, auth and
 * scripts unreachable. These cover the four things that closes, and the two
 * rules that keep it safe to hand an agent - a patch carries only what the
 * caller named, and where a row came from is never the caller's to claim.
 */
describe("document CRUD parity", () => {
	/** The arguments one engine-client fake was called with. */
	function callArgs(fn: unknown, index = 0): unknown[] {
		return (fn as ReturnType<typeof vi.fn>).mock.calls[index];
	}

	/** The zod schema one tool declares for `field`. */
	function schemaOf(tool: string, field: string) {
		const found = TOOLS.find((t) => t.name === tool);
		expect(found, tool).toBeDefined();
		return found!.inputSchema[field] as z.ZodTypeAny;
	}

	describe("saved-request auth and settings", () => {
		const auth = { mode: "bearer", token: "{{apiToken}}" };

		test("create_request stores auth and the four Settings fields", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Get users",
					url: "https://api.example.com/users",
					auth,
					followRedirects: false,
					maxRedirects: 3,
					httpVersion: "http2",
					stream: true,
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.createRequest)[0]).toMatchObject({
				auth,
				followRedirects: false,
				maxRedirects: 3,
				httpVersion: "http2",
				stream: true,
			});
		});

		test("a create that names none of them sends none of them", async () => {
			// The engine's own defaults are the answer for a caller that said
			// nothing; a filler here would store a policy nobody chose.
			const client = fakeClient();
			await dispatchTool(
				"create_request",
				{ collectionId: "col_1", name: "Get users", url: "https://api.example.com/users" },
				ctxWith(client, { allowWrites: true })
			);
			const payload = callArgs(client.createRequest)[0] as Record<string, unknown>;
			for (const key of [
				"auth",
				"followRedirects",
				"maxRedirects",
				"httpVersion",
				"stream",
			]) {
				expect(Object.keys(payload), key).not.toContain(key);
			}
		});

		test("update_request patches only the settings it names", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_request",
				{ requestId: "req_1", maxRedirects: 0 },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// Exactly one key: `PUT /requests/:id` merge-patches, so a defaulted
			// `followRedirects: true` beside it would silently rewrite a policy
			// the user set in the app.
			expect(callArgs(client.updateRequest)[1]).toEqual({ maxRedirects: 0 });
		});

		test("update_request replaces the auth block whole", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", auth: { mode: "none" } },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ auth: { mode: "none" } });
		});

		test("the stored auth input is the run tools' schema, refusals included", () => {
			const run = schemaOf("run_request", "auth");
			const created = schemaOf("create_request", "auth");
			const updated = schemaOf("update_request", "auth");
			const collection = schemaOf("update_collection", "auth");
			const cases: unknown[] = [
				undefined,
				{ mode: "bearer", token: "t" },
				{ mode: "oauth2", clientId: "id", clientSecret: "s" },
				// The refusals: a block with no mode, a bare string, a number, an
				// array. One shared schema means one answer to each.
				{ token: "t" },
				"bearer",
				7,
				[],
			];
			for (const value of cases) {
				const expected = run.safeParse(value).success;
				expect(created.safeParse(value).success, JSON.stringify(value)).toBe(expected);
				expect(updated.safeParse(value).success, JSON.stringify(value)).toBe(expected);
				expect(collection.safeParse(value).success, JSON.stringify(value)).toBe(expected);
			}
			// The four differ only in wording, which is what makes them one schema
			// with four descriptions rather than four schemas.
			expect(run.safeParse({ token: "t" }).success).toBe(false);
			expect(run.safeParse({ mode: "bearer", token: "t" }).success).toBe(true);
		});
	});

	/**
	 * Certificate verification (#795). The stored field was written by the engine
	 * and the app and by no MCP tool, so an agent could neither save a request
	 * against a self-signed host nor restate what `list_requests` showed it. What
	 * these hold is the pair of answers that closes it: the stored field is
	 * writable under the merge-patch rule, and a *per-call* downgrade is refused.
	 */
	describe("certificate verification", () => {
		const allow = { allowlist: ["api.example.com"] };

		test("create_request stores verification off when the caller asks for it", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request",
				{
					collectionId: "col_1",
					name: "Internal health",
					url: "https://internal.example.test/health",
					verifySSL: false,
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.createRequest)[0]).toMatchObject({ verifySSL: false });
		});

		test("update_request patches verifySSL alone", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", verifySSL: false },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ verifySSL: false });
		});

		test("an update that does not name it leaves the stored value alone", async () => {
			// The one field where the merge-patch rule is a security rule: a
			// defaulted `true` here would silently re-enable a check the user
			// turned off, and the request would then fail against the host it was
			// written for.
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", name: "Internal health", httpVersion: "http2" },
				ctxWith(client, { allowWrites: true })
			);
			const payload = callArgs(client.updateRequest)[1] as Record<string, unknown>;
			expect(Object.keys(payload)).not.toContain("verifySSL");
		});

		test("every declared setting is a setting the payload builder reads", () => {
			// The wiring rule, not a restatement of the list: a field added to
			// `requestSettingsInput` and not to `REQUEST_SETTINGS_KEYS` parses
			// happily and reaches the engine never - this repo's most repeated
			// defect. Driven through both verbs because both spread the schema.
			for (const key of REQUEST_SETTINGS_KEYS) {
				expect(schemaOf("create_request", key), key).toBeDefined();
				expect(schemaOf("update_request", key), key).toBeDefined();
			}
		});

		test.each([
			["followRedirects", false],
			["maxRedirects", 3],
			["httpVersion", "http2"],
			["stream", true],
			["verifySSL", false],
		] as const)("update_request forwards %s on its own", async (key, value) => {
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", [key]: value },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ [key]: value });
		});

		test("run_request refuses a per-call downgrade before anything is sent", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: false },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(INSECURE_TLS_REFUSAL);
			// Refused *before* composition, so nothing was even resolved - a
			// refusal after the exchange would be a request already sent.
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
			// The refusal names both supported routes, which is the whole point of
			// answering here rather than dropping an unknown argument.
			expect(firstText(res)).toContain("update_request");
			expect(firstText(res)).toContain("Network & connectivity");
		});

		test("run_request accepts the safe default and forwards nothing for it", async () => {
			// `true` is what the composed payload already carries, so an agent
			// restating it is not argued with - and not echoed into the request
			// overlay either, where it would be a second source for one value.
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			const composed = callArgs(client.composeRequest)[0] as {
				request: Record<string, unknown>;
			};
			expect(Object.keys(composed.request)).not.toContain("verifySSL");
			const executed = callArgs(client.executeRequest)[0] as Record<string, unknown>;
			expect(Object.keys(executed)).not.toContain("verifySSL");
		});

		test("the load and collection runners take no TLS argument at all", () => {
			// One answer, not three: the stored field is the only way a Vayu run
			// skips a certificate check, so no execute/load tool may grow an
			// argument that bypasses the record the app shows.
			for (const name of ["start_load_run", "run_collection", "run_collection_smoke"]) {
				const tool = TOOLS.find((t) => t.name === name);
				expect(tool, name).toBeDefined();
				expect(Object.keys(tool!.inputSchema), name).not.toContain("verifySSL");
			}
		});
	});

	describe("saved examples", () => {
		test("create_request_example marks the row as user-written, whatever the caller claims", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_request_example",
				{
					requestId: "req_1",
					name: "200 OK",
					status: 201,
					headers: { "content-type": "application/json" },
					body: '{"ok":true}',
					contentType: "application/json",
					// The engine accepts this field; the tool must not forward it.
					origin: "import",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			const [requestId, payload] = callArgs(client.createRequestExample) as [
				string,
				Record<string, unknown>,
			];
			expect(requestId).toBe("req_1");
			expect(payload).toEqual({
				name: "200 OK",
				status: 201,
				contentType: "application/json",
				headers: [{ key: "content-type", value: "application/json", enabled: true }],
				body: '{"ok":true}',
				// Forwarding the caller's "import" would hand an agent's row to the
				// next OpenAPI sync to overwrite - the omission is the point.
				origin: "user",
			});
		});

		test("update_request_example patches only what it names, and never the origin", async () => {
			const client = fakeClient();
			await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1", status: 500, origin: "user" },
				ctxWith(client, { allowWrites: true })
			);
			const [requestId, exampleId, payload] = callArgs(client.updateRequestExample) as [
				string,
				string,
				Record<string, unknown>,
			];
			expect(requestId).toBe("req_1");
			expect(exampleId).toBe("exa_1");
			expect(payload).toEqual({ status: 500 });
		});

		test("an update naming no field is refused rather than sent", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(client.updateRequestExample).not.toHaveBeenCalled();
		});

		test("list_request_examples clips one oversized body and says so", async () => {
			const body = "x".repeat(MAX_INLINE_BODY_BYTES + 500);
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([
						{ id: "exa_1", name: "big", status: 200, body, bodyTruncated: false },
					]),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
				bodiesOmitted: number;
			};
			expect(parsed.examples[0]).toMatchObject({
				name: "big",
				bodyClipped: true,
				bodyBytes: body.length,
				// The engine's own flag is a different fact and is left as it was.
				bodyTruncated: false,
			});
			expect((parsed.examples[0].body as string).length).toBe(MAX_INLINE_BODY_BYTES);
			expect(parsed.bodiesOmitted).toBe(0);
		});

		test("the list has a budget: bodies past it are dropped, their rows kept", async () => {
			const body = "x".repeat(MAX_INLINE_BODY_BYTES);
			const rows = [1, 2, 3, 4].map((n) => ({
				id: `exa_${n}`,
				name: `example ${n}`,
				status: 200,
				body,
			}));
			const client = fakeClient({
				listRequestExamples: vi.fn().mockResolvedValue(rows),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
				bodiesOmitted: number;
				bodyBudgetBytes: number;
			};
			expect(parsed.bodyBudgetBytes).toBe(MAX_EXAMPLES_BODY_BYTES);
			expect(parsed.bodiesOmitted).toBe(1);
			// The scalars survive: a row an agent cannot read the body of is
			// still a row it has to know exists.
			expect(parsed.examples[3]).toMatchObject({
				id: "exa_4",
				name: "example 4",
				status: 200,
				bodyOmitted: true,
				bodyBytes: body.length,
			});
			expect(parsed.examples[3].body).toBe("");
			expect(parsed.examples[0].bodyOmitted).toBeUndefined();
		});

		test("a small body is passed through untouched", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "ok", status: 200, body: "{}" }]),
			});
			const res = await dispatchTool(
				"list_request_examples",
				{ requestId: "req_1" },
				ctxWith(client)
			);
			const parsed = JSON.parse(firstText(res)) as {
				examples: Array<Record<string, unknown>>;
			};
			expect(parsed.examples[0]).toEqual({
				id: "exa_1",
				name: "ok",
				status: 200,
				body: "{}",
			});
		});

		test("delete_request_example previews the example and its mock consequence", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "200 OK", status: 200 }]),
			});
			const res = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("200 OK");
			expect(firstText(res)).toMatch(/mock server/i);
			expect(client.deleteRequestExample).not.toHaveBeenCalled();
		});

		test("confirmed, it deletes; unknown, it says so and deletes nothing", async () => {
			const client = fakeClient({
				listRequestExamples: vi
					.fn()
					.mockResolvedValue([{ id: "exa_1", name: "200 OK", status: 200 }]),
			});
			const ctx = ctxWith(client, { allowWrites: true });
			const done = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1", confirmed: true },
				ctx
			);
			expect(done.isError).toBeFalsy();
			expect(client.deleteRequestExample).toHaveBeenCalledWith("req_1", "exa_1", undefined);

			const missing = await dispatchTool(
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_gone", confirmed: true },
				ctx
			);
			expect(missing.isError).toBe(true);
			expect(firstText(missing)).toContain("exa_gone");
			expect(client.deleteRequestExample).toHaveBeenCalledTimes(1);
		});
	});

	describe("collection-level state", () => {
		test("create_collection stores variables, auth and both scripts", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_collection",
				{
					name: "API",
					variables: {
						baseUrl: "https://api.example.com",
						token: { value: "t", secret: true },
					},
					auth: { mode: "apikey", key: "X-Key", value: "{{token}}" },
					preRequestScript: "pm.request.headers.add('x-run', '1')",
					postRequestScript: "pm.test('ok', () => {})",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.createCollection)[0]).toEqual({
				name: "API",
				auth: { mode: "apikey", key: "X-Key", value: "{{token}}" },
				preRequestScript: "pm.request.headers.add('x-run', '1')",
				postRequestScript: "pm.test('ok', () => {})",
				variables: {
					baseUrl: { enabled: true, value: "https://api.example.com" },
					token: { enabled: true, value: "t", secret: true },
				},
			});
		});

		test("update_collection merges variables against the stored blob", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", variables: { token: "t" } },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// The read is what makes it a merge: `PUT /collections/:id` replaces
			// the whole blob, so without it setting `token` would drop `baseUrl`.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				variables: {
					baseUrl: { value: "https://api.example.com", enabled: true },
					token: { enabled: true, value: "t" },
				},
			});
		});

		test("removeVariables deletes a name, and an absent one is reported", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", removeVariables: ["baseUrl", "nope"] },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.updateCollection)[1]).toEqual({ variables: {} });
			// A name that was not there is a caveat beside the result, not an
			// error - the same disclosure update_environment makes.
			expect(res.content.map((c) => c.text).join("\n")).toContain("nope");
		});

		test("a rename still needs no read, and an empty patch is refused", async () => {
			const client = fakeClient();
			const renamed = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", name: "Renamed", preRequestScript: "" },
				ctxWith(client, { allowWrites: true })
			);
			expect(renamed.isError).toBeFalsy();
			expect(client.getCollection).not.toHaveBeenCalled();
			// An empty string is a value: it is how a collection script is cleared.
			expect(callArgs(client.updateCollection)[1]).toEqual({
				name: "Renamed",
				preRequestScript: "",
			});

			const nothing = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(nothing.isError).toBe(true);
			expect(client.updateCollection).toHaveBeenCalledTimes(1);
		});
	});

	describe("move_item", () => {
		/** Two collections at the root, one nested, and a request list per collection. */
		const TREE = [
			{ id: "col_1", name: "API", parentId: "", order: 0 },
			{ id: "col_2", name: "Internal", parentId: "", order: 1 },
			{ id: "col_1a", name: "v1", parentId: "col_1", order: 0 },
		];

		function moveClient(requests: Record<string, unknown[]> = {}) {
			return fakeClient({
				listCollections: vi.fn().mockResolvedValue(TREE),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) => Promise.resolve(requests[id] ?? [])),
			});
		}

		test("a request lands after the collection's current requests", async () => {
			const client = moveClient({
				col_2: [
					{ id: "r1", order: 0 },
					{ id: "r2", order: 1 },
				],
			});
			const res = await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// A dense destination needs no sibling rewritten - only the row that
			// moved, carrying its new owner.
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "request", id: "req_1", order: 2, collectionId: "col_2" }],
			});
		});

		test("position 'first' shifts exactly the siblings whose slot changes", async () => {
			const client = moveClient({
				col_2: [
					{ id: "r1", order: 0 },
					{ id: "r2", order: 2 },
				],
			});
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2", position: "first" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 0, collectionId: "col_2" },
					{ type: "request", id: "r1", order: 1 },
					// r2 already sits at 2, which is where it belongs after the
					// insert - a batch that rewrote it would be writing nothing.
				],
			});
		});

		test("repositioning inside the same collection does not leave the row tied", async () => {
			// The bug this shape exists to prevent: state the whole arrangement,
			// and the moved row cannot land level with the sibling it displaced.
			const client = moveClient({
				col_2: [
					{ id: "r1", order: 0 },
					{ id: "req_1", order: 1 },
					{ id: "r2", order: 2 },
				],
			});
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			const batch = callArgs(client.reorder)[0] as { moves: Array<Record<string, unknown>> };
			expect(batch.moves).toEqual([
				{ type: "request", id: "req_1", order: 2, collectionId: "col_2" },
				{ type: "request", id: "r2", order: 1 },
			]);
			const orders = batch.moves.map((m) => m.order);
			expect(new Set(orders).size).toBe(orders.length);
		});

		test("a legacy collection whose rows all sit at 0 gets real positions", async () => {
			const client = moveClient({
				col_2: [
					{ id: "r1", order: 0 },
					{ id: "r2", order: 0 },
				],
			});
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 2, collectionId: "col_2" },
					{ type: "request", id: "r2", order: 1 },
				],
			});
		});

		test("a collection moves to the top level, and among its new siblings", async () => {
			const client = moveClient();
			await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_1a", parentId: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "collection", id: "col_1a", order: 2, parentId: null }],
			});
		});

		test("a collection cannot move into itself or its own subtree", async () => {
			const client = moveClient();
			const ctx = ctxWith(client, { allowWrites: true });
			const intoSelf = await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_1", parentId: "col_1" },
				ctx
			);
			expect(intoSelf.isError).toBe(true);
			expect(firstText(intoSelf)).toMatch(/itself/i);

			const intoChild = await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_1", parentId: "col_1a" },
				ctx
			);
			expect(intoChild.isError).toBe(true);
			expect(firstText(intoChild)).toContain("col_1a");
			// The engine would refuse the same batch under its lock; refusing here
			// is about naming the problem, so nothing may reach it.
			expect(client.reorder).not.toHaveBeenCalled();
		});

		test("a collection move states its destination or is refused", async () => {
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_1a" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("parentId");
			expect(client.reorder).not.toHaveBeenCalled();
		});

		test("an unknown collection is named rather than sent", async () => {
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_gone", parentId: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("col_gone");
			expect(client.reorder).not.toHaveBeenCalled();
		});
	});

	test("every new write verb refuses before touching the engine when writes are off", async () => {
		const client = fakeClient();
		const calls: Array<[string, Record<string, unknown>, keyof EngineClient]> = [
			[
				"create_request_example",
				{ requestId: "req_1", name: "200 OK" },
				"createRequestExample",
			],
			[
				"update_request_example",
				{ requestId: "req_1", exampleId: "exa_1", status: 500 },
				"updateRequestExample",
			],
			[
				"delete_request_example",
				{ requestId: "req_1", exampleId: "exa_1", confirmed: true },
				"deleteRequestExample",
			],
			["move_item", { type: "request", id: "req_1", collectionId: "col_2" }, "reorder"],
		];
		for (const [tool, args, method] of calls) {
			const res = await dispatchTool(tool, args, ctxWith(client, { allowWrites: false }));
			expect(res.isError, tool).toBe(true);
			expect(client[method], tool).not.toHaveBeenCalled();
		}
		// Nor may one read what it would change while writes are off.
		expect(client.listRequestExamples).not.toHaveBeenCalled();
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("the new tools carry the categories and hints their gates imply", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		expect(byName.get("list_request_examples")?.category).toBe("read");
		for (const name of [
			"create_request_example",
			"update_request_example",
			"delete_request_example",
			"move_item",
		]) {
			expect(byName.get(name)?.category, name).toBe("write");
		}
		expect(byName.get("delete_request_example")?.annotations.destructiveHint).toBe(true);
		expect(byName.get("list_request_examples")?.annotations.readOnlyHint).toBe(true);
	});
});

describe("run_collection_smoke", () => {
	test("runs each request and reports pass/fail; skips off-allowlist hosts", async () => {
		const composedByRequest: Record<string, object> = {
			r1: { method: "GET", url: "https://api.example.com/ok" },
			r2: { method: "GET", url: "https://api.example.com/bad" },
			r3: { method: "GET", url: "https://evil.test/x" },
		};
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "ok", method: "GET", url: "https://api.example.com/ok" },
				{ id: "r2", name: "bad", method: "GET", url: "https://api.example.com/bad" },
				{ id: "r3", name: "offlist", method: "GET", url: "https://evil.test/x" },
			]),
			composeRequest: vi
				.fn()
				.mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve(composedByRequest[requestId])
				),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({ status: 200, testResults: [] })
				.mockResolvedValueOnce({ status: 500, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const summary = res.structuredContent as {
			total: number;
			passed: number;
			failed: number;
			skipped: number;
		};
		expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
		// The off-allowlist request was never executed - and the gate read the
		// *composed* URL, which is why composition (pure, sends nothing) may run
		// for it while execution must not.
		expect((client.executeRequest as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
	});

	test("does not skip a scheme-less host:port request whose host is allowlisted", async () => {
		// A collection saved against "localhost:3000/..." had every request
		// skipped, with a reason blaming unresolved {{variables}} in a URL that
		// carried none.
		const client = fakeClient({
			listRequests: vi
				.fn()
				.mockResolvedValue([
					{ id: "r1", name: "local", method: "GET", url: "localhost:3000/health" },
				]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "localhost:3000/health" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["localhost"] })
		);
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1, skipped: 0 });
		expect(client.executeRequest).toHaveBeenCalledTimes(1);
	});

	test("composes each request engine-side and executes the composed payload unchanged", async () => {
		// Canned engine output mirroring what POST /compose returns for a saved
		// request: variables resolved, inherited auth applied, chain + own script
		// parts attached. The composition itself is asserted engine-side
		// (request_composer_test.cpp); MCP's job is to request it by id and
		// forward it byte-for-byte.
		const composed = {
			method: "GET",
			url: "https://api.example.com/users",
			headers: { Accept: "application/json" },
			auth: { mode: "bearer", token: "abc123" },
			preRequestScripts: [
				{ origin: "collection", id: "c1", script: "pm.collectionVariables.set('x', 1)" },
			],
			postRequestScripts: [
				{
					origin: "request",
					id: "r1",
					script: "pm.test('ok', () => pm.response.to.have.status(200))",
				},
			],
			requestId: "r1",
			environmentId: "env_1",
		};
		const client = fakeClient({
			listRequests: vi
				.fn()
				.mockResolvedValue([{ id: "r1", collectionId: "c1", name: "get user" }]),
			composeRequest: vi.fn().mockResolvedValue(composed),
			executeRequest: vi
				.fn()
				.mockResolvedValue({ status: 200, testResults: [{ passed: true }] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1", environmentId: "env_1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		// Composed by id, scoped by the caller's environment.
		expect(client.composeRequest).toHaveBeenCalledWith(
			{ requestId: "r1", environmentId: "env_1" },
			undefined
		);
		// Executed exactly as composed - resolved once, never re-resolved.
		const outgoing = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(outgoing).toEqual(composed);
		expect((res.structuredContent as { passed: number }).passed).toBe(1);
	});

	test("a request that fails to compose is reported failed, not dropped", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "broken" }]),
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const summary = res.structuredContent as {
			failed: number;
			results: Array<{ error?: string }>;
		};
		expect(summary.failed).toBe(1);
		expect(summary.results[0].error).toMatch(/500/);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	/**
	 * `GET /requests?collectionId=` returns direct children only, so a smoke run
	 * on a parent folder is structurally partial. A green matrix that does not
	 * say so reads as "the whole collection passed".
	 */
	test("discloses the sub-collections it did not run", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "API" },
				{ id: "c2", name: "Billing", parentId: "c1" },
				{ id: "c3", name: "Users", parentId: "c1" },
				{ id: "c4", name: "Unrelated", parentId: "c9" },
				{ id: "c5", name: "Root" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/2 sub-collection\(s\) were NOT run/);
		expect(text).toContain("Billing");
		expect(text).toContain("Users");
		// Only descendants of *this* collection are named.
		expect(text).not.toContain("Unrelated");
		expect(text).not.toContain("Root");
		// The matrix itself is untouched: it counts the direct requests it ran.
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
	});

	/**
	 * The contract's verdict folds into `ok` the way `testResults` does
	 * (issue #681), and the three cases are deliberately spelled differently:
	 * checked-and-wrong fails the request, checked-and-right does not, and a
	 * response the document declares no schema for is neither.
	 */
	test("a response that contradicts its declared schema fails the request", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "matches" },
				{ id: "r2", name: "contradicts" },
				{ id: "r3", name: "undeclared" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: { checked: true, valid: true, failures: [], failuresTotal: 0 },
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: {
						checked: true,
						valid: false,
						failuresTotal: 1,
						failures: [{ path: "/id", message: "unexpected instance type" }],
					},
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [],
					validation: { checked: false, reason: "no_schema_for_status" },
				}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			passed: number;
			failed: number;
			results: Array<{ ok: boolean; schema?: { checked: boolean; failures?: string[] } }>;
		};
		// Only the contradicting one failed - a 200 with an undeclared status
		// schema is not a broken API.
		expect(summary).toMatchObject({ passed: 2, failed: 1 });
		expect(summary.results[0].ok).toBe(true);
		expect(summary.results[1].ok).toBe(false);
		expect(summary.results[2].ok).toBe(true);
		// And the row says *why*, so an agent does not have to re-run to find out.
		expect(summary.results[1].schema?.failures).toEqual(["/id: unexpected instance type"]);
		expect(summary.results[2].schema).toMatchObject({
			checked: false,
			reason: "no_schema_for_status",
		});
	});

	/**
	 * The schema verdict above explains itself on the row; a test failure did
	 * not (issue #733) - `ok:false` beside a 200 named no reason, and an agent
	 * had no way to reach the detail the tool had already been handed. Passing
	 * assertions ride the row too: "2 tests, none failed" is the evidence that
	 * a request judged `ok` was judged against something.
	 */
	test("a request that failed on its tests says which tests failed", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "asserts and passes" },
				{ id: "r2", name: "asserts and fails" },
				{ id: "r3", name: "asserts nothing" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({
					status: 200,
					testResults: [
						{ name: "status is 200", passed: true },
						{ name: "body has id", passed: true },
					],
				})
				.mockResolvedValueOnce({
					status: 200,
					testResults: [
						{ name: "status is 200", passed: true },
						{
							name: "body has id",
							passed: false,
							error: "expected undefined to be a number",
						},
					],
				})
				.mockResolvedValueOnce({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			passed: number;
			failed: number;
			results: Array<{
				ok: boolean;
				tests?: { total: number; failed: number; failures?: string[] };
			}>;
		};
		expect(summary).toMatchObject({ passed: 2, failed: 1 });
		expect(summary.results[0]).toMatchObject({ ok: true, tests: { total: 2, failed: 0 } });
		expect(summary.results[0].tests?.failures).toBeUndefined();
		// The row a `ok:false` with a 200 status would otherwise leave unexplained.
		expect(summary.results[1].ok).toBe(false);
		expect(summary.results[1].tests).toMatchObject({ total: 2, failed: 1 });
		expect(summary.results[1].tests?.failures).toEqual([
			"body has id: expected undefined to be a number",
		]);
		// No assertions ran at all is not "everything passed", so the node is
		// absent rather than a zero the agent would read as a verdict.
		expect(summary.results[2]).toMatchObject({ ok: true });
		expect(summary.results[2].tests).toBeUndefined();
	});

	/**
	 * A pre-request assertion fails for different reasons than one about the
	 * response - a token fetch that did not return one, a fixture that is not
	 * there - and the engine lists both phases since #810. An agent handed the
	 * name alone would read every failure as the latter and go looking at the
	 * response.
	 */
	test("a failing pre-request assertion says it was made before the request", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "logs in first" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [
					{
						name: "token was issued",
						passed: false,
						error: "expected 401 to equal 200",
						source: "pre",
					},
					{ name: "status is 200", passed: false, error: "nope", source: "test" },
				],
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			results: Array<{ tests?: { total: number; failed: number; failures?: string[] } }>;
		};

		expect(summary.results[0].tests).toMatchObject({ total: 2, failed: 2 });
		// Only the pre-request one is labelled: the post-request assertions are
		// what this list has always been.
		expect(summary.results[0].tests?.failures).toEqual([
			"[pre-request] token was issued: expected 401 to equal 200",
			"status is 200: nope",
		]);
	});

	/**
	 * Nothing caps `testResults` upstream, so a script writing hundreds of
	 * failing assertions would otherwise put all of them on one row of a matrix
	 * that already carries a row per request. `failed` stays the true count, so
	 * a cut list is visible as one.
	 */
	test("a row's failed-test list is capped, and the count still reports the total", async () => {
		const testResults = Array.from({ length: 25 }, (_, i) => ({
			name: `check ${i}`,
			passed: false,
			error: "nope",
		}));
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "noisy" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const row = (
			res.structuredContent as {
				results: Array<{ tests?: { total: number; failed: number; failures?: string[] } }>;
			}
		).results[0];
		expect(row.tests).toMatchObject({ total: 25, failed: 25 });
		expect(row.tests?.failures).toHaveLength(10);
		expect(row.tests?.failures?.[0]).toBe("check 0: nope");
	});

	/**
	 * The gate, made switchable (issue #720). Both directions in one test on the
	 * same fixture, because the pair is the claim: the argument has to change
	 * the verdict *and* leave the row's evidence alone. Absent is the on state -
	 * this tool has folded since #681 and says so in its description, so a
	 * default of off would silently pass contract failures for every agent
	 * already reading the matrix.
	 */
	test.each([
		{ label: "absent", args: {}, ok: false, passed: 0, failed: 1 },
		{ label: "true", args: { failOnSchemaError: true }, ok: false, passed: 0, failed: 1 },
		{ label: "false", args: { failOnSchemaError: false }, ok: true, passed: 1, failed: 0 },
	])(
		"failOnSchemaError $label: a contradicting response is ok=$ok, verdict kept either way",
		async ({ args, ok, passed, failed }) => {
			const client = fakeClient({
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "contradicts" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
				executeRequest: vi.fn().mockResolvedValue({
					status: 200,
					testResults: [],
					validation: {
						checked: true,
						valid: false,
						failuresTotal: 1,
						failures: [{ path: "/id", message: "unexpected instance type" }],
					},
				}),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			const summary = res.structuredContent as {
				passed: number;
				failed: number;
				results: Array<{ ok: boolean; schema?: { valid?: boolean; failures?: string[] } }>;
			};
			expect(summary).toMatchObject({ passed, failed });
			expect(summary.results[0].ok).toBe(ok);
			// Withheld from the outcome, never from the row: an agent that turned
			// the gate off still has to be able to see what it turned off.
			expect(summary.results[0].schema).toMatchObject({ valid: false });
			expect(summary.results[0].schema?.failures).toEqual(["/id: unexpected instance type"]);
		}
	);

	test("failOnSchemaError: false does not rescue a failing status or a failing test", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "500s" },
				{ id: "r2", name: "assertion fails" },
			]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi
				.fn()
				.mockResolvedValueOnce({ status: 500, testResults: [] })
				.mockResolvedValueOnce({ status: 200, testResults: [{ passed: false }] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1", failOnSchemaError: false },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.structuredContent).toMatchObject({ passed: 0, failed: 2 });
	});

	test("a collection bound to no document reports no schema field at all", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			// No `validation` node - what the engine returns for an unbound
			// collection. Absent must not become `{checked: false}`, which would
			// claim a contract could not judge this response when there was none.
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as { results: Array<Record<string, unknown>> };
		expect(summary.results[0]).not.toHaveProperty("schema");
	});

	/**
	 * The declared-schema-must-be-updated trap: a field the handler returns but
	 * the `outputSchema` does not declare is rejected by the SDK before an agent
	 * sees it, and only asserting the result against the tool's own schema
	 * catches it.
	 */
	test("what the handler returns validates against the tool's declared outputSchema", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "ok" },
				{ id: "r2", name: "offlist" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url: requestId === "r1" ? "https://api.example.com/ok" : "https://evil.test/x",
				})
			),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [],
				validation: {
					checked: true,
					valid: false,
					failuresTotal: 2,
					failures: [{ path: "", message: "required property 'name' missing" }],
				},
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const tool = TOOLS.find((t) => t.name === "run_collection_smoke");
		expect(tool?.outputSchema).toBeDefined();
		expect(() => tool!.outputSchema!.parse(res.structuredContent)).not.toThrow();
		// A body-level failure keeps a readable location rather than an empty one.
		const summary = res.structuredContent as {
			results: Array<{ schema?: { failures?: string[]; failuresTotal?: number } }>;
		};
		expect(summary.results[0].schema?.failures).toEqual([
			"(body): required property 'name' missing",
		]);
		expect(summary.results[0].schema?.failuresTotal).toBe(2);
	});

	test("says nothing extra when the collection has no sub-collections", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi.fn().mockResolvedValue([{ id: "c1", name: "API" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.content.map((c) => c.text).join("\n")).not.toMatch(/sub-collection/);
	});

	test("an unreadable collection list is disclosed as unchecked, not as no children", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		// The run itself still succeeds - the lookup is a disclosure, not a gate.
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
		expect(res.content.map((c) => c.text).join("\n")).toMatch(
			/could not read the collection list/
		);
	});

	test("the tool description states the scope it actually runs", () => {
		const tool = TOOLS.find((t) => t.name === "run_collection_smoke");
		expect(tool?.description).toMatch(/DIRECT requests/);
		expect(tool?.description).toMatch(/one at a time/);
	});
});

/**
 * Scenario runs from MCP (issue #754), reversing #454's deferral. Two surfaces
 * over one engine route: `run_collection` posts a `scenario` block with no
 * `mode` (design-mode runner), `start_load_run` posts the same block *with* one
 * (virtual users). What these tests own is the same thing every other tool test
 * owns - what reaches `POST /runs`, and that no traffic is arranged before the
 * gates have run. The plan resolution itself is engine-side.
 */
describe("run_collection", () => {
	/** A client whose collection `c1` holds two allowlisted requests. */
	function scenarioClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "checkout" },
			]),
			composeRequest: vi
				.fn()
				.mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({ method: "GET", url: `https://api.example.com/${requestId}` })
				),
			...overrides,
		});
	}

	test("is an execute tool that invalidates runs and the cookie jar", () => {
		const tool = TOOLS.find((t) => t.name === "run_collection");
		expect(tool?.category).toBe("execute");
		// Steps share the environment's jar, the way a Send does.
		expect(tool?.invalidates).toEqual(["run", "cookie"]);
	});

	test("posts the scenario block with rows, recursion and iterations intact", async () => {
		const client = scenarioClient();
		const rows = [{ id: "1" }, { id: "2" }];
		const res = await dispatchTool(
			"run_collection",
			{
				collectionId: "c1",
				environmentId: "env_1",
				recursive: false,
				iterations: 3,
				data: rows,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toEqual({
			scenario: {
				source: "collection",
				collectionId: "c1",
				recursive: false,
				iterations: 3,
				data: rows,
			},
			environmentId: "env_1",
		});
		// The absence of `mode` is what makes this a design-mode run: a mode
		// beside the block would hand the same plan to the load executor.
		expect(payload).not.toHaveProperty("mode");
	});

	test("omits iterations and data when the caller named neither", async () => {
		const client = scenarioClient();
		await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			scenario: Record<string, unknown>;
		};
		// The engine owns both defaults (1 pass, or the row count with data), so
		// a computed copy here would be a second place for that rule to live.
		expect(payload.scenario).not.toHaveProperty("iterations");
		expect(payload.scenario).not.toHaveProperty("data");
		expect(payload.scenario.recursive).toBe(false);
	});

	test("refuses the whole run on the first un-allowlisted step, starting nothing", async () => {
		const client = scenarioClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
				{ id: "r3", name: "checkout" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x"
							: `https://api.example.com/${requestId}`,
				})
			),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		// Named the way the engine names a step, so the row is findable.
		expect(firstText(res)).toMatch(/step 1 \(request 'offsite', id 'r2'\)/);
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).toMatch(/Nothing was started/);
		expect(client.startRun).not.toHaveBeenCalled();
		// The walk stops at the refusal rather than composing the rest.
		expect(client.composeRequest).toHaveBeenCalledTimes(2);
	});

	test("a step that cannot compose refuses the run rather than starting a plan the engine would reject", async () => {
		const client = scenarioClient({
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Cannot compose step 0 \(request 'login', id 'r1'\)/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	/**
	 * The engine emits each sub-collection's whole subtree before the folder's
	 * own requests (`collect_requests`, the sidebar's order). The pre-flight walk
	 * has to agree, or its "first bad step" names a step the run reaches later.
	 */
	test("walks sub-collections in the engine's order when recursive", async () => {
		const requestsByCollection: Record<string, Array<{ id: string; name: string }>> = {
			c1: [{ id: "root_a", name: "root a" }],
			c2: [{ id: "child_a", name: "child a" }],
			c3: [{ id: "grand_a", name: "grand a" }],
		};
		const client = scenarioClient({
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "API" },
				{ id: "c2", name: "Billing", parentId: "c1" },
				{ id: "c3", name: "Invoices", parentId: "c2" },
				{ id: "c9", name: "Elsewhere" },
			]),
			listRequests: vi
				.fn()
				.mockImplementation((id: string) =>
					Promise.resolve(requestsByCollection[id] ?? [])
				),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", recursive: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const composedIds = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls.map(
			(call) => (call[0] as { requestId: string }).requestId
		);
		expect(composedIds).toEqual(["grand_a", "child_a", "root_a"]);
		expect(res.structuredContent).toMatchObject({ plannedSteps: 3 });
		// A collection outside the subtree is not walked.
		expect(client.listRequests).not.toHaveBeenCalledWith("c9", undefined);
	});

	test("a parent cycle terminates instead of walking forever", async () => {
		const client = scenarioClient({
			listCollections: vi.fn().mockResolvedValue([
				{ id: "c1", name: "A", parentId: "c2" },
				{ id: "c2", name: "B", parentId: "c1" },
			]),
			listRequests: vi.fn().mockResolvedValue([]),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", recursive: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		// An empty plan is the engine's refusal to make, not this walk's - what
		// matters here is that the walk returned at all.
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	test("returns the run id with the plan size and how to follow it", async () => {
		const client = scenarioClient({
			startRun: vi.fn().mockResolvedValue({
				runId: "run_7",
				status: "pending",
				message: "Collection run started",
			}),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.structuredContent).toMatchObject({
			runId: "run_7",
			status: "pending",
			plannedSteps: 2,
		});
		// The report's own bound, stated where the agent reads the run id -
		// a 200-step plan does not come back as 200 rows.
		expect(firstText(res)).toMatch(/at most 100 step rows/);
		expect(firstText(res)).toMatch(/get_run_report/);
		// And that the rows carry bodies inline. A design-mode step trace embeds
		// the request and response bodies (`build_result_trace`), unlike a load
		// run's captures, which live behind GET /runs/:id/samples - so an agent
		// told the opposite would size a 100-step report as if it were metadata.
		expect(firstText(res)).toMatch(/bodies inline/);
	});

	test("surfaces the engine's own refusal verbatim", async () => {
		const client = scenarioClient({
			startRun: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						"'scenario.data' has 2000 rows, over the limit of 1000"
					)
				),
		});
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", data: [{ id: "1" }] },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/over the limit of 1000/);
	});

	/**
	 * The contract as a gate (issue #766). `failOnSchemaError` is **run-scoped
	 * and top-level**, beside `scenario` rather than inside it, because that is
	 * where `read_fail_on_schema_error` looks - and it is sent only when the
	 * caller asked for it, so a stored payload carries the key exactly when it
	 * changed what "failed" meant for that run.
	 */
	describe("failOnSchemaError", () => {
		async function payloadFor(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			return (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;
		}

		test("reaches POST /runs top-level, not inside the scenario block", async () => {
			const payload = await payloadFor({ failOnSchemaError: true });
			expect(payload.failOnSchemaError).toBe(true);
			expect(payload.scenario).not.toHaveProperty("failOnSchemaError");
		});

		test.each([
			["omitted", {}],
			["false", { failOnSchemaError: false }],
		])("is absent from the payload when the caller passed %s", async (_label, args) => {
			const payload = await payloadFor(args);
			expect(payload).not.toHaveProperty("failOnSchemaError");
		});

		/**
		 * The two surfaces share one fragment and must not share one default: the
		 * smoke tool has folded the verdict into `ok` since #681, while the
		 * engine's `POST /runs` flag is off unless asked for.
		 */
		test("each surface states its own default, in its own unit", () => {
			const shapeOf = (name: string) =>
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodTypeAny>;
			const scenario = shapeOf("run_collection").failOnSchemaError.description ?? "";
			const smoke = shapeOf("run_collection_smoke").failOnSchemaError.description ?? "";
			expect(scenario).toContain("fails its step (default false)");
			expect(smoke).toContain("fails its request (default true)");
		});
	});
});

describe("start_load_run scenario runs", () => {
	function scenarioLoadClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
			...overrides,
		});
	}

	const allowed = { allowlist: ["api.example.com"] };

	test("posts the scenario block beside the load shape", async () => {
		const client = scenarioLoadClient();
		const rows = [{ id: "1" }];
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1", recursive: true, data: rows },
				mode: "constant_concurrency",
				concurrency: 5,
				duration: "30s",
				environmentId: "env_1",
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
			mode: "constant_concurrency",
			scenario: { source: "collection", collectionId: "c1", recursive: true, data: rows },
			environmentId: "env_1",
			concurrency: 5,
			duration: "30s",
		});
	});

	test("refuses the single-target arguments by name instead of ignoring them", async () => {
		const client = scenarioLoadClient();
		for (const [key, value] of [
			["url", "https://api.example.com/x"],
			["requestId", "req_1"],
			["method", "POST"],
			["auth", { mode: "bearer", token: "t" }],
			["postRequestScript", "pm.test('ok', () => {})"],
			["collectionId", "c1"],
			["maxInFlight", 10],
			["stream", true],
			["sloMs", 500],
		] as Array<[string, unknown]>) {
			const res = await dispatchTool(
				"start_load_run",
				{ scenario: { collectionId: "c1" }, [key]: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, key).toBe(true);
			expect(firstText(res), key).toContain(`"${key}"`);
			expect(firstText(res), key).toMatch(/do not apply to a scenario load run/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
	});

	/**
	 * The schema gate is the design-mode runner's (issue #766): no load path
	 * reads `failOnSchemaError`, so both of this tool's paths refuse it rather
	 * than starting a run whose flag nothing applies. It is *declared* on the
	 * tool for the refusal to be reachable at all - the MCP SDK strips whatever
	 * the schema does not name before a handler sees it.
	 */
	test.each([
		["a scenario", { scenario: { collectionId: "c1" } }],
		["a single target", { url: "https://api.example.com/x" }],
	])("refuses failOnSchemaError beside %s, naming the executor", async (_label, target) => {
		const client = scenarioLoadClient();
		for (const value of [true, false]) {
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, failOnSchemaError: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, String(value)).toBe(true);
			expect(firstText(res), String(value)).toContain('"failOnSchemaError"');
			expect(firstText(res), String(value)).toMatch(/once the run has drained/);
			// The surface that does honour it, so the refusal is a redirection.
			expect(firstText(res), String(value)).toMatch(/run_collection/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
		expect(client.composeRequest).not.toHaveBeenCalled();
	});

	test("declares failOnSchemaError so the refusal survives schema validation", () => {
		// An argument the schema does not declare is stripped by the SDK before
		// the handler runs, which would drop the flag in silence - the failure
		// this refusal exists to prevent.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodTypeAny
		>;
		expect(shape.failOnSchemaError).toBeDefined();
		expect(shape.failOnSchemaError.description).toMatch(/Not available on a load run/);
	});

	test("refuses the two modes the engine cannot drive, with its reasoning", async () => {
		const client = scenarioLoadClient();
		const capacity = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, mode: "capacity", confirmed: true },
			ctxWith(client, allowed)
		);
		expect(capacity.isError).toBe(true);
		expect(firstText(capacity)).toMatch(/one windowed p99/);
		expect(firstText(capacity)).toMatch(/constant_concurrency, ramp_up, iterations/);

		const rps = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, mode: "constant_rps", confirmed: true },
			ctxWith(client, allowed)
		);
		expect(rps.isError).toBe(true);
		expect(firstText(rps)).toMatch(/arrival-rate executor/);

		// The rate itself is what selects that path, whatever mode is declared.
		const rate = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				mode: "constant_concurrency",
				targetRps: 50,
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(rate.isError).toBe(true);
		expect(firstText(rate)).toMatch(/closed-loop by design/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("applies the load caps to virtual users, duration and iterations", async () => {
		const client = scenarioLoadClient();
		const vus = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 5000, confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(vus.isError).toBe(true);
		expect(firstText(vus)).toMatch(/concurrency 5000 exceeds the MCP cap of 50/);

		const duration = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, duration: "2h", confirmed: true },
			ctxWith(client, { ...allowed, maxDurationSeconds: 300 })
		);
		expect(duration.isError).toBe(true);
		expect(firstText(duration)).toMatch(/exceeds the MCP cap of 300s/);

		const iterations = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				mode: "iterations",
				iterations: 999_999,
				confirmed: true,
			},
			ctxWith(client, { ...allowed, maxIterations: 1000 })
		);
		expect(iterations.isError).toBe(true);
		expect(firstText(iterations)).toMatch(/exceeds the MCP cap of 1000/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("injects the capped duration when the caller omitted one", async () => {
		const client = scenarioLoadClient();
		await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, { ...allowed, maxDurationSeconds: 20 })
		);
		// The engine's own default is 60s, so a 20s cap only binds if it is sent.
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
			duration: "20s",
		});
	});

	test("gates every step on the allowlist before anything is started", async () => {
		const client = scenarioLoadClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x"
							: "https://api.example.com/login",
				})
			),
		});
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/step 1 \(request 'offsite', id 'r2'\)/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("previews the planned run and starts nothing until confirmed", async () => {
		const client = scenarioLoadClient();
		const preview = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 4 },
			ctxWith(client, allowed)
		);
		expect(preview.isError).toBeFalsy();
		expect(firstText(preview)).toMatch(/AWAITING CONFIRMATION/);
		expect(firstText(preview)).toMatch(/1 step\(s\) per iteration/);
		expect(client.startRun).not.toHaveBeenCalled();

		const started = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, concurrency: 4, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(started.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	test("a declined elicitation starts nothing", async () => {
		const client = scenarioLoadClient();
		const ctx: ToolContext = {
			...ctxWith(client, allowed),
			elicit: vi.fn().mockResolvedValue({ action: "decline" }),
		};
		const res = await dispatchTool("start_load_run", { scenario: { collectionId: "c1" } }, ctx);
		expect(firstText(res)).toMatch(/declined/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("the scenario block offers no iterations of its own", () => {
		// A load run reads the top-level `iterations`; `scenario.iterations` is the
		// design runner's pass count and the load executor never looks at it, so
		// offering it here would be an argument written and never read.
		const tool = TOOLS.find((t) => t.name === "start_load_run");
		const shape = (tool!.inputSchema.scenario as z.ZodOptional<z.ZodObject<z.ZodRawShape>>)._def
			.innerType.shape;
		expect(Object.keys(shape).sort()).toEqual(["collectionId", "data", "recursive"]);
	});
});

describe("get_live_metrics limit", () => {
	function metricsClient() {
		return fakeClient({ getLiveMetricsSnapshot: vi.fn().mockResolvedValue([]) });
	}

	/**
	 * `limit` reaches `ticks.slice(-limit)`. A non-positive value does not
	 * narrow that window, it widens it: `0` returns every collected tick and
	 * `-3` returns all but the three oldest - the opposite of a limit. So these
	 * must fail loudly rather than be repaired into a plausible answer.
	 */
	test.each([0, -3, 2.5])("rejects limit %s without calling the engine", async (limit) => {
		const client = metricsClient();
		const res = await dispatchTool(
			"get_live_metrics",
			{ runId: "run_1", limit },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/"limit" must be a whole number greater than 0/);
		expect(client.getLiveMetricsSnapshot).not.toHaveBeenCalled();
	});

	test("forwards a positive limit, and defaults to 10 when omitted", async () => {
		const client = metricsClient();
		await dispatchTool("get_live_metrics", { runId: "run_1", limit: 5 }, ctxWith(client));
		expect(client.getLiveMetricsSnapshot).toHaveBeenCalledWith(
			"run_1",
			5,
			undefined,
			undefined
		);

		const bare = metricsClient();
		await dispatchTool("get_live_metrics", { runId: "run_1" }, ctxWith(bare));
		expect(bare.getLiveMetricsSnapshot).toHaveBeenCalledWith("run_1", 10, undefined, undefined);
	});

	test("the input schema rejects a non-positive limit too", () => {
		const shape = TOOLS.find((t) => t.name === "get_live_metrics")!.inputSchema as Record<
			string,
			z.ZodTypeAny
		>;
		expect(shape.limit.safeParse(0).success).toBe(false);
		expect(shape.limit.safeParse(-3).success).toBe(false);
		expect(shape.limit.safeParse(2.5).success).toBe(false);
		expect(shape.limit.safeParse(10).success).toBe(true);
		expect(shape.limit.safeParse(undefined).success).toBe(true);
	});
});

/**
 * A declared `outputSchema` makes the SDK reject any non-error result whose
 * `structuredContent` does not validate, and that rejection reads as the tool's
 * schema being broken - hiding the body. So every 200 the engine can answer
 * with must produce a result the schema accepts.
 */
/**
 * Inline body bounds (issue #767).
 *
 * `run_request` and `get_run_report` were raw passthroughs, and an ordinary
 * page fetch came back as 1.3M characters - over the tool-result token limit,
 * so the agent got an error instead of a response. The bound lives here rather
 * than in the engine: full fidelity is right for a person clicking Send, and
 * what is being violated is specific to a result feeding a context window.
 */
describe("inline body bounds", () => {
	const allow = { allowlist: ["api.example.com"] };
	const huge = "x".repeat(MAX_INLINE_BODY_BYTES + 5_000);

	/** A `/execute` answer in the shape `serialize(Response)` emits. */
	function executeAnswer(over: Record<string, unknown>) {
		return {
			status: 200,
			statusText: "OK",
			headers: { "content-type": "application/json" },
			requestHeaders: {},
			bodySize: 128,
			httpVersion: "2",
			httpVersionDowngraded: false,
			body: null,
			bodyRaw: "",
			timing: { totalMs: 12 },
			...over,
		};
	}

	function executed(answer: Record<string, unknown>) {
		return fakeClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
	}

	async function runRequest(client: EngineClient) {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, allow)
		);
		expect(res.isError).toBeFalsy();
		return JSON.parse(firstText(res)) as Record<string, unknown>;
	}

	test("run_request cuts an oversized body and states its real size", async () => {
		const answer = executeAnswer({ bodyRaw: huge, bodySize: huge.length });
		const out = await runRequest(executed(answer));

		expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
		expect(out.bodyTruncated).toBe(true);
		// The engine's own count, not the size of the slice we kept - the whole
		// point of the flag is to say how much was not sent.
		expect(out.bodySize).toBe(huge.length);
	});

	test("run_request leaves a body under the bound byte-for-byte", async () => {
		const small = JSON.stringify({ userId: 1, id: 5, completed: false });
		const answer = executeAnswer({
			body: { userId: 1, id: 5, completed: false },
			bodyRaw: small,
			bodySize: small.length,
		});
		const out = await runRequest(executed(answer));

		// Exact equality, not a subset: over-truncating an ordinary small
		// response would be its own regression, and so would a stray flag.
		expect(out).toEqual(answer);
		expect(out).not.toHaveProperty("bodyTruncated");
	});

	test("run_request nulls the parsed body once bodyRaw has been cut", async () => {
		const payload = {
			items: Array.from({ length: 4_000 }, (_, i) => ({ i, pad: "xxxxxxxx" })),
		};
		const raw = JSON.stringify(payload);
		expect(raw.length).toBeGreaterThan(MAX_INLINE_BODY_BYTES);
		const out = await runRequest(
			executed(executeAnswer({ body: payload, bodyRaw: raw, bodySize: raw.length }))
		);

		// The doubling case: `body` and `bodyRaw` carry the same payload, so a
		// cut bodyRaw beside an intact parsed body would hand back in full the
		// bytes it just claimed to have dropped.
		expect(out.body).toBeNull();
		expect(out.bodyTruncated).toBe(true);
	});

	test("run_request cuts a large rawRequest but keeps its headers whole", async () => {
		const head = "POST /x HTTP/2\r\nHost: api.example.com\r\nCookie: session=abc\r\n\r\n";
		const out = await runRequest(executed(executeAnswer({ rawRequest: head + huge })));

		const raw = out.rawRequest as string;
		expect(raw.startsWith(head)).toBe(true);
		expect(raw).toContain("Cookie: session=abc");
		expect(Buffer.byteLength(raw, "utf8")).toBe(head.length + MAX_INLINE_BODY_BYTES);
		expect(out.rawRequestTruncated).toBe(true);
		expect(out.rawRequestBytes).toBe(head.length + huge.length);
	});

	test("run_request does not touch a headers-only rawRequest", async () => {
		const answer = executeAnswer({ rawRequest: "GET /x HTTP/2\r\nHost: api.example.com\r\n" });
		expect(await runRequest(executed(answer))).toEqual(answer);
	});

	test("the cut never splits a multi-byte character", async () => {
		// Two-byte characters against a bound that is not a multiple of two:
		// a naive byte slice would end mid-character and decode to U+FFFD.
		const out = await runRequest(
			executed(executeAnswer({ bodyRaw: "é".repeat(MAX_INLINE_BODY_BYTES) }))
		);
		expect(out.bodyRaw as string).not.toContain("�");
		expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
	});

	function reported(report: Record<string, unknown>) {
		return fakeClient({ getRunReport: vi.fn().mockResolvedValue(report) });
	}

	async function runReport(client: EngineClient) {
		const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		return JSON.parse(firstText(res)) as Record<string, unknown>;
	}

	type Row = {
		trace?: { request?: Record<string, unknown>; response?: Record<string, unknown> };
	};

	test("get_run_report cuts a stored trace body on every row", async () => {
		const out = await runReport(
			reported({
				summary: {},
				results: [
					{ id: 1, trace: { request: { url: "u" }, response: { body: huge } } },
					{ id: 2, trace: { request: { url: "u" }, response: { body: huge } } },
				],
			})
		);

		// Per row, not just the first: a scenario run carries one trace per step
		// (up to 100 in a report), which is what multiplies this defect.
		for (const row of out.results as Row[]) {
			const response = row.trace!.response!;
			expect(Buffer.byteLength(response.body as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
			expect(response.bodyTruncated).toBe(true);
			expect(response.bodyBytes).toBe(huge.length);
		}
	});

	test("get_run_report keeps the engine's own bodyBytes when it already truncated", async () => {
		const out = await runReport(
			reported({
				results: [
					{
						id: 1,
						trace: {
							// What a trace the engine cut at maxTraceBodyBytes looks
							// like: a 5MB slice that records the true original size.
							response: { body: huge, bodyTruncated: true, bodyBytes: 40_000_000 },
						},
					},
				],
			})
		);

		const response = (out.results as Row[])[0].trace!.response!;
		expect(response.bodyBytes).toBe(40_000_000);
	});

	test("get_run_report bounds the request side too", async () => {
		const head = "POST /x HTTP/2\r\nHost: api.example.com\r\n\r\n";
		const out = await runReport(
			reported({
				results: [{ id: 1, trace: { request: { body: huge, rawRequest: head + huge } } }],
			})
		);

		const request = (out.results as Row[])[0].trace!.request!;
		expect(Buffer.byteLength(request.body as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
		expect(request.bodyTruncated).toBe(true);
		expect(Buffer.byteLength(request.rawRequest as string, "utf8")).toBe(
			head.length + MAX_INLINE_BODY_BYTES
		);
		expect(request.rawRequestTruncated).toBe(true);
	});

	test("a load-mode report passes through untouched", async () => {
		// A load run's results never go through build_result_trace, so they
		// carry no trace node - exact equality proves the walk added nothing.
		const report = {
			summary: { totalRequests: 5_000 },
			latency: { p95: 12 },
			results: [
				{ id: 1, statusCode: 200, latencyMs: 4 },
				{ id: 2, statusCode: 500, latencyMs: 9, error: "timeout" },
			],
		};
		expect(await runReport(reported(report))).toEqual(report);
	});

	test("a design report under the bound passes through untouched", async () => {
		const report = {
			summary: {},
			results: [
				{ id: 1, trace: { request: { url: "u" }, response: { body: '{"ok":true}' } } },
			],
		};
		expect(await runReport(reported(report))).toEqual(report);
	});

	/**
	 * The scenario shape, pinned ahead of `run_collection` (#754 / PR #765).
	 *
	 * A scenario step is written through the same pair a single `/execute` uses
	 * - `build_result_trace` then `cap_trace_bodies`
	 * (`scenario_runner.cpp:678-689`) - into the same `results.trace_data`
	 * column (`scenario_runner.cpp:715`) that `/runs/:id/report` parses back
	 * into `results[].trace`. So one scenario report carries one such trace per
	 * step, up to the report route's 100-row cap, instead of the single trace
	 * reproduced in #767. This fixture is that shape: step identity stamped on
	 * the trace beside the nodes, and a skipped step whose `response` the
	 * runner erased.
	 */
	test("a scenario report is bounded per step, skipped steps included", async () => {
		const out = await runReport(
			reported({
				summary: {},
				scenario: { iterations: 1, steps: [{ index: 0, name: "login", executed: 1 }] },
				results: [
					{
						id: 1,
						trace: {
							iteration: 0,
							stepIndex: 0,
							stepName: "login",
							outcome: "passed",
							request: { url: "u" },
							response: { body: huge },
						},
					},
					{
						id: 2,
						trace: {
							iteration: 0,
							stepIndex: 1,
							stepName: "checkout",
							outcome: "skipped",
							// No `response` node at all: the runner erases it for a
							// step that never sent.
							request: { body: huge },
						},
					},
				],
			})
		);

		const rows = out.results as Array<Row & { trace: Record<string, unknown> }>;
		expect(Buffer.byteLength(rows[0].trace.response!.body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);
		expect(rows[0].trace.response!.bodyBytes).toBe(huge.length);
		// Identity survives the rebuild - the step list reads these.
		expect(rows[0].trace.stepName).toBe("login");
		// The skipped step's request is bounded, and no empty `response` is
		// invented for it: an erased node must stay erased, or the step's
		// expanded view reads as a server that answered with nothing.
		expect(Buffer.byteLength(rows[1].trace.request!.body as string, "utf8")).toBe(
			MAX_INLINE_BODY_BYTES
		);
		expect(rows[1].trace).not.toHaveProperty("response");
	});

	test("both tool descriptions state the bound", () => {
		for (const name of ["run_request", "get_run_report"]) {
			const description = TOOLS.find((t) => t.name === name)!.description;
			expect(description).toContain(String(MAX_INLINE_BODY_BYTES));
			expect(description).toMatch(/bodyTruncated/);
		}
	});

	/**
	 * The total bound (issue #769).
	 *
	 * The per-node bound does not bound the result: `results[]` holds up to 100
	 * rows and each keeps up to `MAX_INLINE_BODY_BYTES` per node, so a 100-step
	 * scenario measured 3.3M characters with every node correctly flagged as
	 * truncated - 2.5x the 1.3M that failed in #767. At that row count even an
	 * 8KB body, never touched by the per-node cut, totalled 845K.
	 */
	describe("total trace budget", () => {
		/** A scenario row in the shape `stamp_step_identity` writes. */
		function step(index: number, outcome: string, body: string) {
			return {
				id: index + 1,
				statusCode: outcome === "passed" ? 200 : 500,
				latencyMs: 4,
				trace: {
					iteration: 0,
					stepIndex: index,
					stepName: `step-${index}`,
					outcome,
					response: { body },
				},
			};
		}

		function scenarioReport(rows: unknown[]) {
			return { summary: {}, scenario: { stepsStored: rows.length }, results: rows };
		}

		test("a 100-step report of oversized bodies comes back inside the budget", async () => {
			const out = await runReport(
				reported(
					scenarioReport(Array.from({ length: 100 }, (_, i) => step(i, "passed", huge)))
				)
			);

			const rows = out.results as Array<Record<string, unknown>>;
			expect(rows).toHaveLength(100);
			const embedded = rows.filter((row) => row.trace !== undefined);
			const carried = embedded.reduce(
				(sum, row) => sum + Buffer.byteLength(JSON.stringify(row.trace), "utf8"),
				0
			);
			expect(carried).toBeLessThanOrEqual(MAX_REPORT_TRACE_BYTES);
			// The whole result, which is what actually reaches the agent: the
			// pre-fix measurement for this exact fixture was 3,328,454 characters.
			expect(JSON.stringify(out).length).toBeLessThan(200_000);
		});

		test("what was dropped is disclosed on the row and on the report", async () => {
			const out = await runReport(
				reported(
					scenarioReport(Array.from({ length: 100 }, (_, i) => step(i, "passed", huge)))
				)
			);

			const rows = out.results as Array<Record<string, unknown>>;
			const dropped = rows.filter((row) => row.traceOmitted === true);
			expect(dropped.length).toBeGreaterThan(0);
			expect(out.tracesOmitted).toBe(dropped.length);
			expect(out.traceBudgetBytes).toBe(MAX_REPORT_TRACE_BYTES);
			// A dropped row keeps everything that is not the trace - the run's
			// shape is the answer even when the payloads cannot come along.
			expect(dropped[0]).toMatchObject({ statusCode: 200, latencyMs: 4 });
			expect(dropped[0]).not.toHaveProperty("trace");
		});

		test("non-passing steps keep their traces first", async () => {
			// Failures last in run order, so a first-come budget would drop
			// exactly them - which is the engine's rule for `stepsStored`
			// (`ScenarioStepStore::add`) read backwards.
			const rows = [
				...Array.from({ length: 40 }, (_, i) => step(i, "passed", huge)),
				step(40, "failed", huge),
				step(41, "errored", huge),
			];
			const out = await runReport(reported(scenarioReport(rows)));

			const results = out.results as Array<Record<string, unknown>>;
			expect(results).toHaveLength(42);
			// Row order is the run's, not the budget's.
			expect((results[40].trace as Record<string, unknown>).outcome).toBe("failed");
			expect((results[41].trace as Record<string, unknown>).outcome).toBe("errored");
			expect(results[40]).not.toHaveProperty("traceOmitted");
			expect(results[41]).not.toHaveProperty("traceOmitted");
			expect(out.tracesOmitted).toBeGreaterThan(0);
		});

		test("a single oversized row keeps its trace whatever it costs", async () => {
			// The #767 case itself: a design report is one row, and a budget that
			// dropped it would answer nothing at all.
			const out = await runReport(
				reported({
					summary: {},
					results: [
						{
							id: 1,
							trace: {
								request: {
									body: huge,
									rawRequest: `POST /x HTTP/2\r\n\r\n${huge}`,
								},
								response: { body: huge },
							},
						},
					],
				})
			);

			const row = (out.results as Row[])[0];
			expect(Buffer.byteLength(row.trace!.response!.body as string, "utf8")).toBe(
				MAX_INLINE_BODY_BYTES
			);
			expect(out).not.toHaveProperty("tracesOmitted");
		});

		test("a report inside the budget is byte-for-byte unchanged", async () => {
			// Under the per-node bound and under the total: nothing added, no
			// disclosure invented, exactly the object the engine returned.
			const report = scenarioReport(
				Array.from({ length: 30 }, (_, i) => step(i, "passed", '{"ok":true}'))
			);
			expect(await runReport(reported(report))).toEqual(report);
		});

		test("rows carrying no trace are never counted or flagged", async () => {
			// A load report has no traces at all, so there is nothing to omit -
			// the budget must not invent a disclosure for rows it cannot spend on.
			const report = {
				summary: { totalRequests: 5_000 },
				results: Array.from({ length: 100 }, (_, i) => ({
					id: i,
					statusCode: 200,
					latencyMs: 4,
				})),
			};
			expect(await runReport(reported(report))).toEqual(report);
		});

		test("the tool description states the total bound and its disclosure", () => {
			const description = TOOLS.find((t) => t.name === "get_run_report")!.description;
			expect(description).toContain(String(MAX_REPORT_TRACE_BYTES));
			expect(description).toMatch(/traceOmitted/);
			expect(description).toMatch(/tracesOmitted/);
		});
	});
});

describe("get_engine_health output always satisfies its own schema", () => {
	const healthSchema = () => TOOLS.find((t) => t.name === "get_engine_health")!.outputSchema!;

	test.each([
		["a bare string", "starting"],
		["a number", 7],
		["an array", [1, 2]],
		["null", null],
		["an object with no status", { uptime: 12 }],
	])("wraps %s from a 200 body", async (_label, body) => {
		const client = fakeClient({ health: vi.fn().mockResolvedValue(body) });
		const res = await dispatchTool("get_engine_health", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(healthSchema().safeParse(res.structuredContent).success).toBe(true);
		expect(res.structuredContent).toMatchObject({ status: "unknown" });
		// The body an operator needs is carried, not swallowed.
		expect(res.structuredContent).toHaveProperty("raw", body ?? null);
	});

	test("a well-formed health body passes through untouched", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_engine_health", {}, ctxWith(client));
		expect(res.structuredContent).toEqual({ status: "ok", version: "1.2.3" });
		expect(healthSchema().safeParse(res.structuredContent).success).toBe(true);
	});
});

describe("dispatchTool", () => {
	test("get_engine_health passes the engine response through", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_engine_health", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain("1.2.3");
	});

	test("unknown tool returns an error result", async () => {
		const res = await dispatchTool("nope", {}, ctxWith(fakeClient()));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/unknown tool/i);
	});

	test("list_requests without collectionId is a readable arg error", async () => {
		const res = await dispatchTool("list_requests", {}, ctxWith(fakeClient()));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/collectionId.*required/i);
	});

	test("run_request is blocked by the empty default allowlist", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/allowlist is empty/i);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("run_request proceeds for an allowlisted host and builds the payload", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				method: "POST",
				body: '{"a":1}',
				bodyType: "json",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.executeRequest).toHaveBeenCalledTimes(1);
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			method: "POST",
			url: "https://api.example.com/users",
			// Body is emitted as { mode, content } - the shape the engine reads.
			body: { mode: "json", content: '{"a":1}' },
		});
	});

	/**
	 * `stream: true` (issue #575). `tools/call` is request/response, so an agent
	 * is never handed a stream - it is handed what the stream produced inside
	 * bounds it named, with the bound it stopped at stated beside the payload.
	 */
	describe("run_request with stream: true", () => {
		const allow = { allowlist: ["api.example.com"] };
		const started = { runId: "run_s", eventsUrl: "/runs/run_s/events", status: "running" };

		function streamingClient(consumed: Record<string, unknown>) {
			return fakeClient({
				executeRequest: vi.fn().mockResolvedValue(started),
				consumeStreamEvents: vi.fn().mockResolvedValue(consumed),
			});
		}

		test("the flag is sent explicitly on every call, streaming or not", async () => {
			const off = fakeClient();
			await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x" },
				ctxWith(off, allow)
			);
			const offPayload = (off.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			// Never elided: the two answers have different shapes, so a caller
			// that let a default decide would not know which one to parse.
			expect(offPayload).toMatchObject({ stream: false });

			const on = streamingClient({ events: [], completed: true, capReached: false });
			await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(on, allow)
			);
			const onPayload = (on.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(onPayload).toMatchObject({ stream: true });
		});

		test("returns the events with the bounds it read them under", async () => {
			const client = streamingClient({
				events: [{ event: "tick", data: "1" }],
				completed: true,
				capReached: false,
				endReason: "completed",
				totalEvents: 1,
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({
				runId: "run_s",
				completed: true,
				capReached: false,
				budgetExhausted: false,
				endReason: "completed",
				totalEvents: 1,
				eventCount: 1,
			});
			expect(client.consumeStreamEvents).toHaveBeenCalledWith("run_s", 50, 5_000, undefined);
		});

		test("a capped read says so rather than reading as the whole stream", async () => {
			const client = streamingClient({
				events: [{ event: "tick" }, { event: "tick" }],
				completed: false,
				capReached: true,
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, maxStreamEvents: 2 },
				ctxWith(client, allow)
			);
			// The three stopping conditions are separate because the follow-up
			// differs; collapsing them into "partial" would lose that.
			expect(res.structuredContent).toMatchObject({
				completed: false,
				capReached: true,
				budgetExhausted: false,
				maxStreamEvents: 2,
			});
			expect(firstText(res)).toMatch(/still streaming/i);
		});

		test("a read that ran out its budget is neither complete nor capped", async () => {
			const client = streamingClient({ events: [], completed: false, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, streamBudgetMs: 200 },
				ctxWith(client, allow)
			);
			expect(res.structuredContent).toMatchObject({
				budgetExhausted: true,
				streamBudgetMs: 200,
			});
		});

		test("a budget beyond the ceiling is refused before anything is sent", async () => {
			const client = streamingClient({ events: [], completed: true, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true, streamBudgetMs: 600_000 },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/60000 or less/);
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("the allowlist still gates the resolved URL", async () => {
			const client = streamingClient({ events: [], completed: true, capReached: false });
			const res = await dispatchTool(
				"run_request",
				{ url: "https://elsewhere.test/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(client.executeRequest).not.toHaveBeenCalled();
			expect(client.consumeStreamEvents).not.toHaveBeenCalled();
		});

		test("an answer with no runId is handed back rather than followed", async () => {
			const client = fakeClient({
				executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
			});
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/events", stream: true },
				ctxWith(client, allow)
			);
			expect(res.isError).toBeFalsy();
			expect(client.consumeStreamEvents).not.toHaveBeenCalled();
		});

		test("the tool description names its bounds before the payload", () => {
			const schema = TOOLS.find((t) => t.name === "run_request")!.inputSchema as Record<
				string,
				{ description?: string }
			>;
			// The `aaba1d8` discipline: a caveat an agent reads after believing
			// the data is a caveat that arrived too late.
			expect(schema.stream.description).toMatch(/BOUNDED/);
			expect(schema.stream.description).toMatch(/streamBudgetMs/);
			expect(schema.stream.description).toMatch(/maxStreamEvents/);
		});
	});

	/**
	 * Both these tools have offered `form-data` / `x-www-form-urlencoded` in
	 * their `bodyType` description since they existed, while emitting
	 * `{ mode, content }` - a shape the engine reads no fields out of, so the
	 * request went out with an empty body (issue #381) and now is refused
	 * outright. The string is split into the `fields` rows every other producer
	 * builds, which is what makes the advertised mode real.
	 */
	test.each(["form-data", "x-www-form-urlencoded"])(
		"run_request sends a %s body as fields",
		async (bodyType) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					url: "https://api.example.com/users",
					method: "POST",
					body: "name=ada+lovelace&role=engineer",
					bodyType,
				},
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.body).toEqual({
				mode: bodyType,
				fields: [
					{ key: "name", value: "ada lovelace", enabled: true },
					{ key: "role", value: "engineer", enabled: true },
				],
			});
		}
	);

	/**
	 * The owner scenario behind #417: a bare GraphQL document handed to
	 * `run_request`. The envelope is the *engine's* to apply
	 * (`http/graphql_body.cpp`, pinned end to end by
	 * `graphql_body_test.cpp::ABareDocumentIsEnvelopedOnTheWire`), so what this
	 * layer owes is the document unchanged under `mode: "graphql"` - the one
	 * hop the engine test cannot see. Mutation check: envelope it here, or let
	 * `graphql` fall into `FORM_BODY_MODES` and arrive as `fields`, and the
	 * body assertion reddens.
	 */
	/**
	 * The xml mode has no envelope and no completer anywhere in the stack - the
	 * engine sends `body.content` byte for byte - so what this layer owes is the
	 * document unchanged under `mode: "xml"`. Mutation check: let `xml` fall into
	 * `FORM_BODY_MODES` and it arrives split into `fields`, which is issue #381's
	 * empty-body failure wearing a new mode.
	 */
	/**
	 * A data row rides *beside* the composed payload, not through composition
	 * (issue #601).
	 *
	 * `{{data.*}}` survives `/compose` by design - that is what lets the engine
	 * bind it per iteration - so the row has to reach `/execute` as its own
	 * field. Mutation check: pass `data` into the `/compose` body instead and
	 * the assertion on the execute payload goes red, which is the shape of the
	 * bug (the tokens would reach the wire written as they stand).
	 */
	test("run_request passes a data row to /execute, not to /compose", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users/{{data.id}}",
				data: { id: "7", email: "ada@example.test" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();

		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request.data).toBeUndefined();
		expect(composeBody.data).toBeUndefined();

		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.data).toEqual({ id: "7", email: "ada@example.test" });
		// The token is still written when the engine gets it - binding it is the
		// engine's, and composition deliberately leaves it alone.
		expect(payload.url).toBe("https://api.example.com/users/{{data.id}}");
	});

	test("run_request omits data entirely when no row was named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// Absent, not an empty object: an empty row is a row, and the engine
		// reads it as one - `pm.iterationData` would become a scope answering
		// undefined per key rather than being undefined itself.
		expect("data" in payload).toBe(false);
	});

	test("run_request sends an xml document to the engine as written", async () => {
		const envelope = "<soap:Envelope><soap:Body><Ping/></soap:Body></soap:Envelope>";
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/soap",
				method: "POST",
				body: envelope,
				bodyType: "xml",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({ mode: "xml", content: envelope });
	});

	test("run_request sends a bare graphql document to the engine as stored", async () => {
		const query = "query Hero { hero { name } }";
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/graphql",
				method: "POST",
				body: query,
				bodyType: "graphql",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({ mode: "graphql", content: query });
		// Named separately from the toEqual above: the failure this guards
		// against is a well-meant `{"query": ...}` wrap here, which would leave
		// the engine wrapping it a second time.
		expect(payload.body.content).not.toContain('"query"');
		expect(firstText(res)).toContain("200");
	});

	test("create_request stores a form body as fields", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "New",
				url: "https://api.example.com/x",
				method: "POST",
				body: "a=1&b=2",
				bodyType: "x-www-form-urlencoded",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({
			body: {
				mode: "x-www-form-urlencoded",
				fields: [
					{ key: "a", value: "1", enabled: true },
					{ key: "b", value: "2", enabled: true },
				],
			},
			bodyType: "x-www-form-urlencoded",
		});
	});

	test("run_request forwards an ad-hoc pre-request script the agent supplied", async () => {
		// Parsed through the tool's own inputSchema first, because that is the
		// only thing standing between the agent and the engine: `registerTool`
		// hands the SDK this shape, and a zod object *strips* keys it does not
		// declare. `buildExecutionPayload` has always read `preRequestScript`
		// off `args`, but until it was declared here nothing could put it there
		// - so a request the agent asked to have signed went out unsigned.
		// dispatchTool alone does not validate, so asserting on it would pass
		// with the field removed and prove nothing.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const args = z.object(tool!.inputSchema as Record<string, z.ZodTypeAny>).parse({
			url: "https://api.example.com/users",
			preRequestScript: "pm.request.headers['X-Signature'] = 'abc';",
			postRequestScript: "pm.test('ok', function () {});",
		});

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.preRequestScript).toBe("pm.request.headers['X-Signature'] = 'abc';");
		expect(payload.postRequestScript).toBe("pm.test('ok', function () {});");
	});

	test("no execute tool asks the engine for pm.sendRequest, and an agent cannot ask for it", async () => {
		// The allowlist is checked here, before the engine is called, so a
		// request issued from inside a script could never be checked (issue
		// #302). The engine therefore denies script-issued requests unless the
		// payload says otherwise - and this layer must never say otherwise.
		//
		// Both halves matter. The first is that nothing here sets the field.
		// The second is that an agent cannot set it either: the tool builds its
		// request from named arguments, and the inputSchema does not declare
		// `allowScriptRequests`, so zod strips it before it can ride through
		// composition. Asserting only the first would stay green if the handler
		// ever started spreading raw args into the payload.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const args = z.object(tool!.inputSchema as Record<string, z.ZodTypeAny>).parse({
			url: "https://api.example.com/users",
			allowScriptRequests: true,
			preRequestScript: "pm.sendRequest('https://evil.example.com', function () {});",
		});
		expect(args).not.toHaveProperty("allowScriptRequests");

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("allowScriptRequests");
	});

	test("start_load_run does not offer a pre-request script", () => {
		// POST /runs never runs one - only the deferred `tests` script - so
		// offering the field would promise a hook that silently does nothing.
		// The renderer's load path sends no pre-request script either, so this
		// asymmetry is the app's, not MCP's.
		const loadRun = TOOLS.find((t) => t.name === "start_load_run");
		expect(loadRun).toBeDefined();
		expect(Object.keys(loadRun!.inputSchema)).not.toContain("preRequestScript");
		expect(Object.keys(loadRun!.inputSchema)).toContain("tests");
	});

	test("start_load_run offers scenario runs rather than deferring them", () => {
		// #454 scoped them out and said so in the description; #754 reversed that.
		// The description is where an agent learns a collection can be the target
		// at all, so it has to name the argument and what `concurrency` becomes.
		const loadRun = TOOLS.find((t) => t.name === "start_load_run");
		expect(loadRun?.description).toMatch(/scenario/i);
		expect(loadRun?.description).toMatch(/virtual users/);
		expect(loadRun?.description).not.toMatch(/cannot be started from here/);
		expect(Object.keys(loadRun!.inputSchema)).toContain("scenario");
	});

	test("both execute-shaped tools name the validation script the same way", () => {
		// One field in the app - the request builder's Tests tab - drives both
		// Send and a load run. It reached the engine under two names
		// (`postRequestScript` on /execute, `tests` on /runs), and MCP exposed
		// whichever name its endpoint used, so a script an agent wrote for
		// run_request could not be handed to start_load_run unchanged.
		for (const name of ["run_request", "start_load_run"]) {
			const shape = TOOLS.find((t) => t.name === name)!.inputSchema as Record<
				string,
				z.ZodTypeAny
			>;
			expect(Object.keys(shape)).toContain("postRequestScript");
			// The engine's own spelling stays accepted on both: a zod object
			// strips what it does not declare, so dropping it from either tool
			// would turn a script the agent believes is running into silence.
			expect(Object.keys(shape)).toContain("tests");
		}
	});

	/**
	 * Parse through the tool's own `inputSchema` before dispatching, as the SDK
	 * does in production: a zod object strips undeclared keys, so a test that
	 * hands `dispatchTool` the argument directly passes even with the field
	 * removed from the schema and proves nothing.
	 */
	const parseArgs = (name: string, args: Record<string, unknown>) =>
		z
			.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodTypeAny>)
			.parse(args);

	test("start_load_run sends postRequestScript to /runs under the key it reads", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				postRequestScript: "pm.test('ok', function () {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.tests).toBe("pm.test('ok', function () {});");
		// Forwarding it verbatim would look right and validate nothing: the
		// engine's run config reads `tests` and never `postRequestScript`.
		expect(payload.postRequestScript).toBeUndefined();
	});

	test("start_load_run forwards thresholds under the engine's own metric keys", async () => {
		// The keys travel verbatim to POST /runs and come back in the report's
		// thresholdValidation, so a rename anywhere on this path is a budget
		// the engine rejects - or worse, one it accepts and never judges.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				thresholds: { latencyP99Ms: 50, maxErrorRatePct: 0.1 },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.thresholds).toEqual({ latencyP99Ms: 50, maxErrorRatePct: 0.1 });
	});

	test("start_load_run forwards the monitor block to /runs unchanged", async () => {
		// The keys are the engine's own and `validate_run_config` is what judges
		// them, so anything renamed or dropped on this path is a scrape the run
		// silently never performs.
		const client = fakeClient();
		const monitor = {
			url: "http://localhost:9100/metrics",
			intervalMs: 2000,
			format: "prometheus" as const,
			series: ["process_cpu_seconds_total", "go_memstats_heap_inuse_bytes"],
		};
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.monitor).toEqual(monitor);
	});

	test("start_load_run sends no monitor key when none was asked for", () => {
		const parsed = parseArgs("start_load_run", { url: "https://api.example.com" });
		expect(parsed.monitor).toBeUndefined();
	});

	test("start_load_run allows a loopback monitor beside a non-loopback target", async () => {
		// The allowlist decision, in the shape that motivates it: the target is a
		// public host on the list, the vitals endpoint is the machine's own
		// exporter and is on no list at all.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor: { url: "http://127.0.0.1:9100/metrics", series: ["up"] },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	test("start_load_run refuses a public monitor host that is not allowlisted", async () => {
		// The other half of the same decision - and the run must not start, since
		// a refusal that still generated load would be no guard at all.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				monitor: { url: "https://metrics.evil.test/m", series: ["up"] },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/monitor endpoint is a second host/i);
		expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	test("start_load_run leaves the monitor block's ranges to the engine", () => {
		// Deliberate: `monitor.series`' ceiling is the `monitorMaxSeries` setting,
		// so a copy of it here would refuse blocks the engine accepts. The schema
		// types the shape only - a wrong *type* is still caught.
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { url: "http://localhost:9100/m", intervalMs: 1, series: ["a"] },
			})
		).not.toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { url: "http://localhost:9100/m", series: "cpu" },
			})
		).toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				monitor: { series: ["a"] },
			})
		).toThrow();
	});

	test("start_load_run sends no thresholds key when none were declared", () => {
		// An empty object is a 400 from POST /runs, so "no budgets" has to be
		// an absent key rather than an empty one.
		const parsed = parseArgs("start_load_run", { url: "https://api.example.com" });
		expect(parsed.thresholds).toBeUndefined();
		expect(() =>
			parseArgs("start_load_run", { url: "https://api.example.com", thresholds: {} })
		).toThrow(/at least one budget/i);
	});

	test("start_load_run rejects a budget the engine would reject", () => {
		// The schema's bounds mirror the engine's so the agent is told which
		// field is wrong, rather than meeting an HTTP 400 with no field named.
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				thresholds: { maxErrorRatePct: 150 },
			})
		).toThrow();
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				thresholds: { latencyP99Ms: 0 },
			})
		).toThrow();
	});

	test("start_load_run still accepts the engine's own `tests` spelling", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				tests: "pm.test('a', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.tests).toBe("pm.test('a', () => {});");
	});

	test("run_request accepts `tests` as the same script as postRequestScript", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", {
				url: "https://api.example.com/users",
				tests: "pm.test('b', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.postRequestScript).toBe("pm.test('b', () => {});");
	});

	test.each(["run_request", "start_load_run"])(
		"%s rejects both names for one script rather than picking one",
		async (name) => {
			// Two different scripts under two names for one slot: whichever is
			// dropped, the agent is told the run validated something it did not.
			const client = fakeClient();
			const res = await dispatchTool(
				name,
				parseArgs(name, {
					url: "https://api.example.com",
					confirmed: true,
					postRequestScript: "pm.test('a', () => {});",
					tests: "pm.test('b', () => {});",
				}),
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/i);
			expect(client.startRun).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		}
	);

	test("run_request hands /compose the raw request and executes what it returns", async () => {
		// The engine resolves {{host}}; MCP must send it raw (never pre-resolved -
		// that would be a second interpolation pass) and forward the composed URL.
		const client = fakeClient({
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/users" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://{{host}}/users", environmentId: "env_1", collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.composeRequest).toHaveBeenCalledWith(
			{
				request: { method: "GET", url: "https://{{host}}/users" },
				collectionId: "c1",
				environmentId: "env_1",
			},
			undefined
		);
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.url).toBe("https://api.example.com/users");
	});

	test("run_request sends the auth block raw for the engine to resolve and apply", async () => {
		// `{{apiToken}}` and the inherit walk are engine-side; MCP forwards the
		// block untouched inside the compose body.
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				environmentId: "env_1",
				auth: { mode: "bearer", token: "{{apiToken}}" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request.auth).toEqual({ mode: "bearer", token: "{{apiToken}}" });
	});

	test("run_request off-allowlist check runs against the RESOLVED host", async () => {
		// {{host}} resolves (engine-side) to a host that is not allowlisted; the
		// gate must read the composed URL, not the raw argument. Composition
		// itself is pure - no traffic - so composing before gating is safe, but
		// execution must never happen.
		const client = fakeClient({
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://evil.test/x" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://{{host}}/x", environmentId: "env_1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	// The ad-hoc path has no saved request behind it, so an agent-supplied
	// httpVersion is the only way to specify the protocol at all - it is
	// forwarded when present, same treatment as the other ad-hoc string args
	// (preRequestScript, environmentId, ...).
	test("run_request forwards an agent-supplied httpVersion", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users", httpVersion: "http2" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
	});

	test("start_load_run previews (no run) when confirmed is absent", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run starts the run when confirmed", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		expect(client.startRun).toHaveBeenCalledTimes(1);
	});

	// --- Load caps reach every field the run is actually built from (#312) ---

	test("start_load_run refuses a startConcurrency over the cap", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				mode: "ramp_up",
				concurrency: 10,
				startConcurrency: 900,
				duration: "30s",
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxConcurrency: 200 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/startConcurrency 900 exceeds/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run refuses an unbounded iterations run", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				mode: "iterations",
				iterations: 1_000_000_000,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxIterations: 10000 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/iterations 1000000000 exceeds the MCP cap of 10000/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("the schema refuses load counts the engine reads as enormous", () => {
		// `-1` is the natural "unlimited" guess and casts to ~1.8e19 engine-side,
		// where it is a request count, a ramp seed and an in-flight ceiling, not
		// an error. `maxInFlight` bounds in-flight *downward*, so the enormous
		// value is the one that removes the backpressure it was asked for.
		for (const field of ["startConcurrency", "iterations", "maxInFlight"]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: -1 })
			).toThrow();
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: 0 })
			).toThrow();
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", [field]: 2.5 })
			).toThrow();
		}
	});

	test("the schema's maxInFlight ceiling is the engine's, inclusive", () => {
		// The bound exists so an out-of-range value is named here rather than
		// returned as an opaque 400 from POST /runs - which means it has to be
		// the *same* bound, not a stricter guess. 500,000 is what the engine's
		// own default formula reaches at 50k RPS, so refusing it would refuse a
		// run the engine starts on its own.
		for (const value of [1, 500_000, MAX_IN_FLIGHT_BOUND]) {
			expect(() =>
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					maxInFlight: value,
				})
			).not.toThrow();
		}
		expect(() =>
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				maxInFlight: MAX_IN_FLIGHT_BOUND + 1,
			})
		).toThrow();
	});

	test("the maxInFlight ceiling is the one the load dialog advertises", () => {
		// Third copy of the same number: engine header, renderer constant, this
		// schema. `electron/` production code may not import `src/`, so the copy
		// stays - and this is the half of the chain that keeps it honest, the
		// renderer-to-engine half living in
		// `src/constants/load-test.engine-parity.test.ts`. An agent and a human
		// composing the same run must be accepted or refused identically.
		expect(MAX_IN_FLIGHT_BOUND).toBe(LOAD_TEST_LIMITS.MAX_IN_FLIGHT.MAX);
	});

	test("start_load_run sends an explicit duration when the cap is under the engine default", async () => {
		// An omitted duration is 60s engine-side, so a 30s cap that says nothing
		// gets a 60s run.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxDurationSeconds: 30 })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.duration).toBe("30s");
	});

	test("start_load_run leaves the duration alone when the cap is above the engine default", async () => {
		const client = fakeClient();
		await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"], maxDurationSeconds: 300 })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.duration).toBeUndefined();
	});

	test("start_load_run forwards the stream flag and both caps", async () => {
		// Forwarded verbatim, bounded only by the engine's own ranges: the
		// engine validates before the run row exists, so re-deriving the rule
		// here would be a second copy to keep in step (issue #576).
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				targetRps: 10,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
				stream: true,
				maxStreamDurationMs: 20_000,
				maxStreamEvents: 50,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.stream).toBe(true);
		expect(payload.maxStreamDurationMs).toBe(20_000);
		expect(payload.maxStreamEvents).toBe(50);
	});

	test("start_load_run sends no stream key when the agent named none", async () => {
		// The engine refuses `stream` beside `transient` and refuses a cap
		// without `stream`, so a defaulted `false` would turn "said nothing"
		// into a claim the engine has to judge.
		const client = fakeClient();
		await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				concurrency: 10,
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("stream");
		expect(payload).not.toHaveProperty("maxStreamEvents");
	});

	test("the stream cap schema accepts exactly the engine's ranges", () => {
		// Same posture as the maxInFlight ceiling above: a value this schema
		// accepts must be one POST /runs accepts, or the agent gets an opaque
		// 400 instead of a named refusal.
		for (const args of [
			{ maxStreamDurationMs: 1000 },
			{ maxStreamDurationMs: 86_400_000 },
			{ maxStreamEvents: 1 },
			{ maxStreamEvents: 10_000_000 },
		]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", ...args })
			).not.toThrow();
		}
		for (const args of [
			{ maxStreamDurationMs: 999 },
			{ maxStreamDurationMs: 86_400_001 },
			{ maxStreamEvents: 0 },
			{ maxStreamEvents: 10_000_001 },
			{ maxStreamEvents: 2.5 },
		]) {
			expect(() =>
				parseArgs("start_load_run", { url: "https://api.example.com", ...args })
			).toThrow();
		}
	});

	test("start_load_run forwards an agent-supplied httpVersion", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				targetRps: 100,
				mode: "constant_rps",
				duration: "30s",
				confirmed: true,
				httpVersion: "http2",
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
	});

	// --- Load-testing a saved request (#176) --------------------------------
	//
	// The gap these close: `start_load_run` used to send only an ad-hoc `tests`
	// string, so "load test this saved request" through MCP ran none of the
	// assertions the same request runs in the app. Composition is engine-side
	// (`POST /compose`, #226) - the same path run_collection_smoke uses - and
	// the composed scripts ride under `postRequestScripts`, which POST /runs
	// reads as an alias of `tests`.

	// Canned engine output for composing req_1 by id: what
	// request_composer_test.cpp proves the engine produces.
	const composedSavedRequest = {
		method: "POST",
		url: "https://api.example.com/users",
		headers: { "X-Api": "v1" },
		body: { mode: "json", content: '{"a":1}' },
		preRequestScripts: [
			{ origin: "request", id: "req_1", script: "pm.request.headers['X-Sig'] = 'abc';" },
		],
		postRequestScripts: [
			{
				origin: "collection",
				id: "col_1",
				name: "API",
				script: "pm.test('chain', function () {});",
			},
			{ origin: "request", id: "req_1", script: "pm.test('own', function () {});" },
		],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		requestId: "req_1",
	};

	// The fake mirrors the engine's overlay rule: inline `request` fields lay
	// over the stored request before the composed result comes back.
	const savedRequestClient = (composedOverrides: Record<string, unknown> = {}) =>
		fakeClient({
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
							: Promise.reject(
									new EngineRequestError("Engine responded 404", 404, "")
								)
				),
		});

	test("start_load_run composes a saved request, chain test scripts included", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The saved request defines the target - no `url` was passed at all.
		expect(payload.url).toBe("https://api.example.com/users");
		expect(payload.method).toBe("POST");
		expect(payload.headers).toMatchObject({ "X-Api": "v1" });
		expect(payload.requestId).toBe("req_1");
		// The whole point: the collection's assertion and the request's own both
		// travel, in chain-then-own order, under the key /runs now reads.
		expect(payload.postRequestScripts).toEqual([
			{
				origin: "collection",
				id: "col_1",
				name: "API",
				script: "pm.test('chain', function () {});",
			},
			{ origin: "request", id: "req_1", script: "pm.test('own', function () {});" },
		]);
	});

	test("start_load_run reports the pre-request script it cannot run", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// POST /runs has no pre-request hook, so the script must not be sent
		// pretending it will run...
		expect(payload.preRequestScripts).toBeUndefined();
		// ...and the agent has to be told, or a request that signs itself goes
		// out unsigned with nothing saying so.
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/pre-request script\(s\).*NOT applied/i);
	});

	// Under either agent-facing name - `postRequestScript` is the one both
	// execute-shaped tools declare, `tests` the engine spelling kept as an alias.
	test.each(["postRequestScript", "tests"])(
		"start_load_run: an explicit %s replaces the saved request's composed scripts",
		async (key) => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					requestId: "req_1",
					[key]: "pm.test('adhoc', function () {});",
					duration: "30s",
					confirmed: true,
				},
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.tests).toBe("pm.test('adhoc', function () {});");
			// Must be cleared, not merely accompanied: /runs reads both names and
			// prefers the list, so leaving it would run the saved request's
			// assertions and silently ignore the ones the agent asked for.
			expect(payload.postRequestScripts).toBeUndefined();
		}
	);

	test("start_load_run: an explicit url retargets the saved request", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				url: "https://staging.example.com/users",
				duration: "30s",
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["staging.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.url).toBe("https://staging.example.com/users");
		// Only the stated field is overridden; the rest of the request stands.
		expect(payload.method).toBe("POST");
		expect(payload.postRequestScripts).toHaveLength(2);
	});

	// The saved request stores http1.1 and the agent asks for http2, so a pass
	// cannot come from both sides agreeing on the "auto" default. The override
	// must ride inside the compose body's `request` overlay - /compose always
	// emits a stored request's protocol, so an override left out of the overlay
	// loses to the stored value while the tool advertises the argument.
	test("start_load_run: an explicit httpVersion overrides the saved request's", async () => {
		const client = savedRequestClient({ httpVersion: "http1.1" });
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", httpVersion: "http2", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request).toMatchObject({ httpVersion: "http2" });
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http2");
		// Only the stated field is overridden; the rest of the request stands.
		expect(payload.url).toBe("https://api.example.com/users");
		expect(payload.postRequestScripts).toHaveLength(2);
	});

	// The other half of the rule: with nothing stated the stored protocol runs,
	// so no overlay may be sent that would write a default over it.
	test("start_load_run keeps the saved request's httpVersion when none is stated", async () => {
		const client = savedRequestClient({ httpVersion: "http1.1" });
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.request).toBeUndefined();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.httpVersion).toBe("http1.1");
	});

	test("start_load_run checks the allowlist against the saved request's host", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["elsewhere.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run needs a url or a requestId, and says so", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/requestId/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run reports an unknown requestId instead of running an empty request", async () => {
		const client = fakeClient({
			composeRequest: vi
				.fn()
				.mockRejectedValue(new EngineRequestError("Engine responded 404", 404, "")),
		});
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_missing", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/req_missing/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run enforces caps before any run is started", async () => {
		// Composition (pure, sends nothing) may run first - the caps and the
		// allowlist stand between the composed payload and any actual traffic.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", targetRps: 999999, confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"], maxRps: 1000 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/exceeds the MCP cap/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("compare_runs fetches both reports", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRunReport).toHaveBeenCalledTimes(2);
		expect(firstText(res)).toContain("run_a");
		// An explicit base is used as given - no baseline lookup happens.
		expect(client.listBaselineRuns).not.toHaveBeenCalled();
	});

	/*
	 * The reports this tool reads come straight off `GET /runs/:id/report` -
	 * nothing transforms them on the way in, the way the renderer's query layer
	 * does - so the status mix arrives in the engine's own serialization: an
	 * array of `[code, count]` pairs, because `std::map<int, size_t>` cannot be
	 * a JSON object. Read as a record it yielded index keys with tuple values,
	 * every count was skipped, and the tool reported an empty mix as if the run
	 * had recorded no responses at all.
	 */
	test("compare_runs reads the engine's raw [code, count] status mix", async () => {
		const reports: Record<string, unknown> = {
			run_a: {
				latency: { p99: 40 },
				summary: { avgRps: 100 },
				statusCodes: [
					[200, 5970],
					[500, 30],
				],
			},
			run_b: {
				latency: { p99: 80 },
				summary: { avgRps: 90 },
				statusCodes: [
					[200, 5292],
					[500, 108],
				],
			},
		};
		const client = fakeClient({
			getRunReport: vi.fn().mockImplementation((id: string) => Promise.resolve(reports[id])),
		});

		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({
			statusCodes: {
				"200": { base: 5970, target: 5292 },
				"500": { base: 30, target: 108 },
			},
		});
	});

	/*
	 * Omitting the base is the "did my change regress?" shape: the agent knows
	 * the run it just started and not which older run is the reference. It
	 * resolves through the same endpoint the history view's strip uses, so the
	 * two cannot answer the question about different pairs of runs.
	 */
	test("compare_runs falls back to the target's pinned baseline", async () => {
		const client = fakeClient();
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBeFalsy();
		expect(client.getRun).toHaveBeenCalledWith("run_b", undefined);
		expect(client.listBaselineRuns).toHaveBeenCalledWith("req_1", undefined);
		expect(client.getRunReport).toHaveBeenCalledWith("run_pinned", undefined);
		expect(firstText(res)).toContain("run_pinned");
	});

	test("compare_runs says so when the request has no baseline pinned", async () => {
		const client = fakeClient({ listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }) });
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/No run is pinned as the baseline/i);
		// And nothing was compared against a run nobody chose.
		expect(client.getRunReport).not.toHaveBeenCalled();
	});

	test("compare_runs says so when the target ran no saved request", async () => {
		const client = fakeClient({
			getRun: vi.fn().mockResolvedValue({ id: "run_b", requestId: null }),
		});
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/did not run a saved request/i);
		expect(client.listBaselineRuns).not.toHaveBeenCalled();
	});

	test("compare_runs refuses to compare the baseline with itself", async () => {
		const client = fakeClient({
			listBaselineRuns: vi
				.fn()
				.mockResolvedValue({ data: [{ id: "run_b", baseline: true }] }),
		});
		const res = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctxWith(client));

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/is itself the baseline/i);
		expect(client.getRunReport).not.toHaveBeenCalled();
	});

	/*
	 * The direction label is the half of a delta a number cannot carry, and an
	 * agent reading `delta: -12` has no other way to know whether that is good.
	 */
	test("compare_runs labels which direction is an improvement", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockResolvedValue({
				latency: { p99: 40 },
				summary: { avgRps: 100, totalRequests: 10 },
				statusCodes: {},
			}),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);

		const parsed = JSON.parse(firstText(res)) as {
			latency: Array<{ metric: string; direction: string }>;
			throughput: Array<{ metric: string; direction: string }>;
			reliability: Array<{ metric: string; direction: string }>;
		};
		expect(parsed.latency.find((m) => m.metric === "latency.p99")?.direction).toBe(
			"lower-is-better"
		);
		expect(parsed.throughput.find((m) => m.metric === "summary.avgRps")?.direction).toBe(
			"higher-is-better"
		);
		expect(
			parsed.reliability.find((m) => m.metric === "summary.totalRequests")?.direction
		).toBe("neutral");
	});
});

/**
 * The engine reads `concurrency` as an eager per-worker curl-handle
 * pre-allocation, so a negative one becomes ~1.8e19 and allocates until malloc
 * fails. It now returns a 400 instead, but "-1 means unlimited" is exactly the
 * guess an agent makes, and the schema is where that gets a name rather than an
 * HTTP error. Asserted on the schema itself, since `dispatchTool` calls the
 * handler directly - the MCP SDK is what validates args in production.
 */
describe("start_load_run rejects an unusable concurrency at the schema", () => {
	const concurrencySchema = () => {
		const tool = TOOLS.find((t) => t.name === "start_load_run");
		expect(tool).toBeDefined();
		const shape = tool!.inputSchema as Record<string, z.ZodTypeAny>;
		expect(shape.concurrency).toBeDefined();
		return shape.concurrency;
	};

	test.each([-1, 0, 1.5])("rejects concurrency %s", (value) => {
		expect(concurrencySchema().safeParse(value).success).toBe(false);
	});

	test("accepts an ordinary concurrency, and its absence", () => {
		expect(concurrencySchema().safeParse(50).success).toBe(true);
		expect(concurrencySchema().safeParse(undefined).success).toBe(true);
	});
});

/**
 * An abort is the one transport failure that means the engine *was* reachable
 * and busy: it may already have sent the request and written the run row. The
 * old handling matched `/abort/i` alongside ECONNREFUSED and answered "engine
 * not running, retry", which is wrong twice over and talks an agent into
 * re-firing a request that already ran.
 */
describe("engine transport failures are told apart", () => {
	async function runRequestFailingWith(err: unknown) {
		const client = fakeClient({ executeRequest: vi.fn().mockRejectedValue(err) });
		return dispatchTool(
			"run_request",
			{ url: "https://api.example.com/slow" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
	}

	test("a client-budget timeout names the budget and sends the agent to run history", async () => {
		const res = await runRequestFailingWith(
			new EngineTimeoutError("POST", "/execute", 130_000)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/130s budget/);
		expect(firstText(res)).toMatch(/may still have completed/i);
		expect(firstText(res)).toMatch(/list_runs/);
		expect(firstText(res)).not.toMatch(/Make sure the Vayu app is running/);
	});

	test("a cancelled call is not reported as an unreachable engine either", async () => {
		const res = await runRequestFailingWith(
			new DOMException("The operation was aborted.", "AbortError")
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/cancelled/i);
		expect(firstText(res)).toMatch(/list_runs/);
		expect(firstText(res)).not.toMatch(/Make sure the Vayu app is running/);
	});

	test("a genuinely unreachable engine still says so", async () => {
		const res = await runRequestFailingWith(
			new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876")
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Make sure the Vayu app is running/);
	});
});

/*
 * The local OAuth 2.0 mock issuer (#509). The engine has served
 * `/mock-issuer/*` since #479; these three tools are what let an agent asked to
 * "test this auth flow" mint its own tokens instead of having a human curl the
 * engine first.
 */
describe("mock issuer tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));

	test("start, stop and update are execute, list is read, and none of them opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_issuer")?.category).toBe("execute");
		expect(tools.get("stop_mock_issuer")?.category).toBe("execute");
		expect(tools.get("update_mock_issuer")?.category).toBe("execute");
		expect(tools.get("list_mock_issuers")?.category).toBe("read");
		for (const name of [
			"start_mock_issuer",
			"stop_mock_issuer",
			"update_mock_issuer",
			"list_mock_issuers",
		]) {
			// Loopback-only by engine contract, so an agent's client must not be
			// told these reach an open world - that hint is what a cautious client
			// asks about before calling.
			expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			expect(tools.get(name)?.annotations.destructiveHint, name).toBeFalsy();
		}
	});

	test("the mutating ones invalidate the services family, the read stays silent", () => {
		// The other half of the #502 coordination: the drawer reads issuers, so
		// the tools that change what it would show declare the entity that
		// refreshes it (#757). A read declaring one would be the inverse defect.
		for (const name of ["start_mock_issuer", "stop_mock_issuer", "update_mock_issuer"]) {
			expect(byName().get(name)?.invalidates, name).toEqual(["service"]);
		}
		expect(byName().get("list_mock_issuers")?.invalidates).toEqual([]);
	});

	test("start sends only the fields the caller named and returns the issuer's urls", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_mock_issuer",
			{
				expiresInSeconds: 60,
				claims: { sub: "alice", roles: ["admin"] },
				issueRefreshTokens: true,
			},
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startMockIssuer as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An absent field must stay absent: the engine reads a present one with a
		// bad value as a 400 rather than falling back to its default, and
		// `undefined` would serialize to `null`.
		expect(payload).toEqual({
			expiresInSeconds: 60,
			claims: { sub: "alice", roles: ["admin"] },
			issueRefreshTokens: true,
		});
		expect(Object.keys(payload as object)).not.toContain("port");
		expect(Object.keys(payload as object)).not.toContain("failureMode");
		const body = JSON.parse(firstText(res)) as Record<string, unknown>;
		expect(body.issuerId).toBe("issuer_1");
		expect(body.tokenUrl).toBe("http://127.0.0.1:41234/token");
		expect(body.authorizeUrl).toBe("http://127.0.0.1:41234/authorize");
		expect(body.signingKey).toBe("k3y");
	});

	test("start forwards every configurable field, none renamed on the way", async () => {
		const client = fakeClient();
		const args = {
			port: 41234,
			expiresInSeconds: 3600,
			claims: { sub: "alice" },
			clients: [{ clientId: "cid", clientSecret: "s3cret" }],
			failureMode: "slow",
			slowMs: 2000,
			issueRefreshTokens: false,
		};
		const res = await dispatchTool("start_mock_issuer", args, ctxWith(client));
		expect(res.isError).toBeFalsy();
		// Keyed exactly as `parse_mock_issuer_settings` reads them - a rename here
		// is a field the engine silently ignores.
		expect((client.startMockIssuer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(args);
	});

	test("list round-trips the engine's envelope", async () => {
		const running = {
			issuers: [
				{ issuerId: "issuer_1", tokenUrl: "http://127.0.0.1:41234/token", port: 41234 },
			],
		};
		const client = fakeClient({ listMockIssuers: vi.fn().mockResolvedValue(running) });
		const res = await dispatchTool("list_mock_issuers", {}, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual(running);
	});

	test("stop names the issuer, and an unknown id is an error rather than a shrug", async () => {
		const client = fakeClient();
		const ok = await dispatchTool(
			"stop_mock_issuer",
			{ issuerId: "issuer_1" },
			ctxWith(client)
		);
		expect(ok.isError).toBeFalsy();
		expect(client.stopMockIssuer).toHaveBeenCalledWith("issuer_1", undefined);

		const gone = fakeClient({
			stopMockIssuer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock issuer not found")
				),
		});
		const res = await dispatchTool("stop_mock_issuer", { issuerId: "issuer_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/404/);
	});

	test("stop refuses an empty id before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("stop_mock_issuer", { issuerId: "" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.stopMockIssuer).not.toHaveBeenCalled();
	});

	test("update sends only the fields it was asked to change", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1", failureMode: "server_error" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// A merge-patch: `slowMs` absent means "leave it", and spelling it as
		// null or 0 would mean something else entirely.
		expect(client.updateMockIssuer).toHaveBeenCalledWith(
			"issuer_1",
			{ failureMode: "server_error" },
			undefined
		);
	});

	test("update forwards both mutable settings under the engine's own names", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1", failureMode: "slow", slowMs: 2500 },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// Keyed as `read_mutable_settings` reads them - a rename here is a field
		// the engine silently ignores while the tool reports success.
		expect(client.updateMockIssuer).toHaveBeenCalledWith(
			"issuer_1",
			{ failureMode: "slow", slowMs: 2500 },
			undefined
		);
	});

	test("update refuses an empty patch rather than reporting a no-op as done", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/failureMode/);
		// The engine accepts `{}` and answers 200, so without this the agent is
		// told its change landed when nothing changed.
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
	});

	test("update refuses a start-only setting through the schema, not the engine", () => {
		const shape = TOOLS.find((t) => t.name === "update_mock_issuer")!.inputSchema as Record<
			string,
			z.ZodTypeAny
		>;
		// Port, clients, claims and issueRefreshTokens cannot change under a bound
		// listener - the engine answers "stop it and start a new one" - so they
		// are not offered here at all.
		for (const key of ["port", "clients", "claims", "issueRefreshTokens", "expiresInSeconds"]) {
			expect(shape[key], key).toBeUndefined();
		}
		expect(shape.failureMode.safeParse("explode").success).toBe(false);
		expect(shape.failureMode.safeParse("none").success).toBe(true);
		expect(shape.slowMs.safeParse(-1).success).toBe(false);
	});

	test("update surfaces an unknown id as an error", async () => {
		const gone = fakeClient({
			updateMockIssuer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock issuer not found")
				),
		});
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_9", failureMode: "none" },
			ctxWith(gone)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/404/);
	});

	/*
	 * The gating matrix. The issuer is loopback-only by engine contract, so
	 * neither of the two gates that govern the other effectful tools applies: the
	 * allowlist exists to stop an agent generating traffic against third parties,
	 * and the write toggle gates saved data. What does govern them is the per-tool
	 * switch - and an agent that could already reach `POST /mock-issuer/start`
	 * through `run_request` with `localhost` allowlisted gains no capability here.
	 */
	test("neither the empty allowlist nor the write toggle gates them", async () => {
		const client = fakeClient();
		const locked = ctxWith(client, { allowlist: [], allowAll: false, allowWrites: false });
		for (const [tool, args] of [
			["start_mock_issuer", {}],
			["list_mock_issuers", {}],
			["update_mock_issuer", { issuerId: "issuer_1", failureMode: "none" }],
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, locked);
			expect(res.isError, tool).toBeFalsy();
		}
		expect(client.startMockIssuer).toHaveBeenCalled();
		expect(client.updateMockIssuer).toHaveBeenCalled();
		expect(client.stopMockIssuer).toHaveBeenCalled();
	});

	test("the per-tool switch is what turns them off", async () => {
		const client = fakeClient();
		const off = ctxWith(client, {
			disabledTools: [
				"start_mock_issuer",
				"list_mock_issuers",
				"update_mock_issuer",
				"stop_mock_issuer",
			],
		});
		for (const [tool, args] of [
			["start_mock_issuer", {}],
			["list_mock_issuers", {}],
			["update_mock_issuer", { issuerId: "issuer_1", failureMode: "none" }],
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/disabled in Vayu Settings/);
		}
		expect(client.startMockIssuer).not.toHaveBeenCalled();
		expect(client.listMockIssuers).not.toHaveBeenCalled();
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
		expect(client.stopMockIssuer).not.toHaveBeenCalled();
	});

	test("the schema refuses a malformed config before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_issuer")!.inputSchema as Record<
			string,
			z.ZodTypeAny
		>;
		// A failure mode outside the closed set would start an issuer that behaves
		// nothing like the one the agent asked for.
		expect(shape.failureMode.safeParse("explode").success).toBe(false);
		expect(shape.failureMode.safeParse("invalid_client").success).toBe(true);
		expect(shape.claims.safeParse("sub=alice").success).toBe(false);
		expect(shape.claims.safeParse({ sub: "alice" }).success).toBe(true);
		expect(shape.port.safeParse(70000).success).toBe(false);
		expect(shape.port.safeParse(1.5).success).toBe(false);
		expect(shape.port.safeParse(0).success).toBe(true);
		expect(shape.expiresInSeconds.safeParse(0).success).toBe(false);
		expect(shape.slowMs.safeParse(-1).success).toBe(false);
		expect(shape.clients.safeParse([{ clientSecret: "s" }]).success).toBe(false);
		expect(shape.clients.safeParse([{ clientId: "cid" }]).success).toBe(true);
		// Every field is optional: an issuer with no config at all is the common
		// "I just need a token" case.
		expect(z.object(shape).safeParse({}).success).toBe(true);
	});

	test("an agent mints a token against its own issuer, end to end", async () => {
		// The owner scenario from #509, through the MCP layer: stand up an issuer,
		// point a request at the token URL it returned, get a token back.
		const client = fakeClient({
			executeRequest: vi.fn().mockImplementation((payload: Record<string, unknown>) =>
				Promise.resolve(
					String(payload.url ?? "").endsWith("/token")
						? {
								statusCode: 200,
								body: JSON.stringify({
									access_token: "header.payload.signature",
									token_type: "Bearer",
									expires_in: 3600,
								}),
							}
						: { statusCode: 404 }
				)
			),
		});
		const ctx = ctxWith(client, { allowlist: ["127.0.0.1"] });

		const started = await dispatchTool(
			"start_mock_issuer",
			{ clients: [{ clientId: "cid", clientSecret: "s3cret" }] },
			ctx
		);
		expect(started.isError).toBeFalsy();
		const { tokenUrl } = JSON.parse(firstText(started)) as { tokenUrl: string };

		const token = await dispatchTool(
			"run_request",
			{
				method: "POST",
				url: tokenUrl,
				bodyType: "x-www-form-urlencoded",
				body: "grant_type=client_credentials&client_id=cid&client_secret=s3cret",
			},
			ctx
		);
		expect(token.isError).toBeFalsy();
		const sent = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(sent.url).toBe(tokenUrl);
		expect(firstText(token)).toContain("header.payload.signature");

		const stopped = await dispatchTool(
			"stop_mock_issuer",
			{ issuerId: (JSON.parse(firstText(started)) as { issuerId: string }).issuerId },
			ctx
		);
		expect(stopped.isError).toBeFalsy();
		expect(client.stopMockIssuer).toHaveBeenCalledWith("issuer_1", undefined);
	});
});

/*
 * The collection mock server (#757). The engine has served `/mock/*` since #481
 * and the UI has driven it since 0.16.0; these four tools are what let an agent
 * asked to "stand up the API this client expects" do it from the collection's
 * own saved examples rather than writing a stub server.
 */
describe("mock server tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));

	test("start and stop are execute, the two reads are read, and none opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_server")?.category).toBe("execute");
		expect(tools.get("stop_mock_server")?.category).toBe("execute");
		expect(tools.get("list_mock_servers")?.category).toBe("read");
		expect(tools.get("get_mock_routes")?.category).toBe("read");
		for (const name of [
			"start_mock_server",
			"stop_mock_server",
			"list_mock_servers",
			"get_mock_routes",
		]) {
			// Loopback-only by engine contract (`listener.start ("127.0.0.1", …)`),
			// so a cautious client must not be told these reach an open world.
			expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			// A mock serves stored examples and records nothing, so a stop loses
			// nothing that was not recreatable by starting it again.
			expect(tools.get(name)?.annotations.destructiveHint, name).toBeFalsy();
		}
	});

	test("the mutating ones invalidate the services family, the reads stay silent", () => {
		expect(byName().get("start_mock_server")?.invalidates).toEqual(["service"]);
		expect(byName().get("stop_mock_server")?.invalidates).toEqual(["service"]);
		expect(byName().get("list_mock_servers")?.invalidates).toEqual([]);
		expect(byName().get("get_mock_routes")?.invalidates).toEqual([]);
	});

	test("start sends the collection plus only the knobs the caller named", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1", latencyMs: 250 },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startMockServer as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An absent knob stays absent: the engine reads a present one with a bad
		// value as a 400 rather than falling back to its default.
		expect(payload).toEqual({ collectionId: "col_1", latencyMs: 250 });
		expect(Object.keys(payload as object)).not.toContain("port");
		expect(Object.keys(payload as object)).not.toContain("errorRatePct");
		const body = JSON.parse(firstText(res)) as Record<string, unknown>;
		expect(body.mockId).toBe("mock_1");
		expect(body.url).toBe("http://127.0.0.1:45010");
		expect(body.routeCount).toBe(4);
	});

	test("start forwards every knob under the engine's own names", async () => {
		const client = fakeClient();
		const args = { collectionId: "col_1", port: 45010, latencyMs: 100, errorRatePct: 25 };
		const res = await dispatchTool("start_mock_server", args, ctxWith(client));
		expect(res.isError).toBeFalsy();
		// Keyed exactly as `parse_mock_start` reads them - a rename here is a knob
		// the engine silently ignores while the tool reports it applied.
		expect((client.startMockServer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(args);
	});

	test("start refuses a missing collection before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("start_mock_server", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/collectionId/);
		expect(client.startMockServer).not.toHaveBeenCalled();
	});

	test("a mock whose routes have no examples says so, instead of leaving it in the JSON", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_2",
				url: "http://127.0.0.1:45011",
				routeCount: 5,
				routesWithoutExample: 3,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// "It started" and "it can answer" are different answers, and only the
		// second is what was asked for - three of five routes answer 501 here.
		const caveat = res.content.map((c) => c.text).join("\n");
		expect(caveat).toMatch(/3 of 5 route\(s\) have no saved example/);
		expect(caveat).toMatch(/501/);
	});

	test("a mock with no routes at all gets the sharper caveat", async () => {
		const client = fakeClient({
			startMockServer: vi.fn().mockResolvedValue({
				mockId: "mock_3",
				url: "http://127.0.0.1:45012",
				routeCount: 0,
				routesWithoutExample: 0,
			}),
		});
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_empty" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/serves no routes/);
		expect(text).toMatch(/404/);
	});

	test("a fully-exampled mock gets no caveat at all", async () => {
		// The mutation check for the two above: with nothing to warn about, the
		// result is the engine's record and nothing else.
		const res = await dispatchTool(
			"start_mock_server",
			{ collectionId: "col_1" },
			ctxWith(fakeClient())
		);
		expect(res.isError).toBeFalsy();
		expect(res.content).toHaveLength(1);
	});

	test("list and routes round-trip the engine's envelopes", async () => {
		const running = {
			data: [
				{
					mockId: "mock_1",
					collectionId: "col_1",
					collectionName: "API",
					url: "http://127.0.0.1:45010",
					port: 45010,
					routeCount: 4,
				},
			],
		};
		const client = fakeClient({ listMockServers: vi.fn().mockResolvedValue(running) });
		const listed = await dispatchTool("list_mock_servers", {}, ctxWith(client));
		expect(listed.isError).toBeFalsy();
		expect(JSON.parse(firstText(listed))).toEqual(running);

		const routes = await dispatchTool("get_mock_routes", { mockId: "mock_1" }, ctxWith(client));
		expect(routes.isError).toBeFalsy();
		expect(client.getMockServerRoutes).toHaveBeenCalledWith("mock_1", undefined);
		// The has-example flag is the whole point of the table - it is what says
		// which routes answer 501 rather than a body.
		const table = JSON.parse(firstText(routes)) as { data: Array<Record<string, unknown>> };
		expect(table.data[0].hasExample).toBe(true);
		expect(table.data[0].path).toBe("/users");
	});

	test("routes refuses an empty id before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_mock_routes", { mockId: "" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.getMockServerRoutes).not.toHaveBeenCalled();
	});

	test("stop names the mock, and an unknown id is an error rather than a shrug", async () => {
		const client = fakeClient();
		const ok = await dispatchTool("stop_mock_server", { mockId: "mock_1" }, ctxWith(client));
		expect(ok.isError).toBeFalsy();
		expect(client.stopMockServer).toHaveBeenCalledWith("mock_1", undefined);

		const gone = fakeClient({
			stopMockServer: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock server not found")
				),
		});
		const res = await dispatchTool("stop_mock_server", { mockId: "mock_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/404/);
	});

	test("the schema refuses a malformed knob before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_server")!.inputSchema as Record<
			string,
			z.ZodTypeAny
		>;
		expect(shape.port.safeParse(70000).success).toBe(false);
		expect(shape.port.safeParse(0).success).toBe(true);
		// A percentage is 0-100 by definition rather than by an engine constant,
		// which is why this bound lives here and `latencyMs`'s ceiling does not.
		expect(shape.errorRatePct.safeParse(101).success).toBe(false);
		expect(shape.errorRatePct.safeParse(100).success).toBe(true);
		expect(shape.latencyMs.safeParse(-1).success).toBe(false);
		// The collection is the one thing a mock cannot be started without.
		expect(z.object(shape).safeParse({}).success).toBe(false);
		expect(z.object(shape).safeParse({ collectionId: "col_1" }).success).toBe(true);
	});

	/*
	 * The gating matrix, for the same reason the issuer block carries one: a mock
	 * is loopback-only by engine contract, so neither the allowlist (which exists
	 * to stop an agent generating traffic against third parties) nor the write
	 * toggle (which gates saved data - a mock only reads it) applies.
	 */
	test("neither the empty allowlist nor the write toggle gates them", async () => {
		const client = fakeClient();
		const locked = ctxWith(client, { allowlist: [], allowAll: false, allowWrites: false });
		for (const [tool, args] of [
			["start_mock_server", { collectionId: "col_1" }],
			["list_mock_servers", {}],
			["get_mock_routes", { mockId: "mock_1" }],
			["stop_mock_server", { mockId: "mock_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, locked);
			expect(res.isError, tool).toBeFalsy();
		}
		expect(client.startMockServer).toHaveBeenCalled();
		expect(client.stopMockServer).toHaveBeenCalled();
	});

	test("the per-tool switch is what turns them off", async () => {
		const client = fakeClient();
		const off = ctxWith(client, {
			disabledTools: [
				"start_mock_server",
				"list_mock_servers",
				"get_mock_routes",
				"stop_mock_server",
			],
		});
		for (const [tool, args] of [
			["start_mock_server", { collectionId: "col_1" }],
			["list_mock_servers", {}],
			["get_mock_routes", { mockId: "mock_1" }],
			["stop_mock_server", { mockId: "mock_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/disabled in Vayu Settings/);
		}
		expect(client.startMockServer).not.toHaveBeenCalled();
		expect(client.stopMockServer).not.toHaveBeenCalled();
	});

	test("an agent stands up a mock, reads its table and points a request at it", async () => {
		// The owner scenario from #481, through the MCP layer: start a mock for a
		// collection, confirm what it serves, send to it, stop it.
		const client = fakeClient();
		const ctx = ctxWith(client, { allowlist: ["127.0.0.1"] });

		const started = await dispatchTool("start_mock_server", { collectionId: "col_1" }, ctx);
		expect(started.isError).toBeFalsy();
		const { mockId, url } = JSON.parse(firstText(started)) as { mockId: string; url: string };

		const routes = await dispatchTool("get_mock_routes", { mockId }, ctx);
		expect(routes.isError).toBeFalsy();
		const { data } = JSON.parse(firstText(routes)) as { data: Array<{ path: string }> };

		const sent = await dispatchTool(
			"run_request",
			{ method: "GET", url: `${url}${data[0].path}` },
			ctx
		);
		expect(sent.isError).toBeFalsy();
		expect((client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].url).toBe(
			"http://127.0.0.1:45010/users"
		);

		const stopped = await dispatchTool("stop_mock_server", { mockId }, ctx);
		expect(stopped.isError).toBeFalsy();
		expect(client.stopMockServer).toHaveBeenCalledWith("mock_1", undefined);
	});
});

/*
 * Run housekeeping (#755): the History surface an agent could not reach - find a
 * run, page its stored series, pin a baseline, delete one.
 */
describe("run housekeeping tools", () => {
	const forwarded = (client: EngineClient, method: keyof EngineClient) =>
		(client[method] as unknown as ReturnType<typeof vi.fn>).mock.calls[0];

	describe("list_runs", () => {
		test("with no arguments it asks for the documented default page", async () => {
			const client = fakeClient();
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "listRuns")[0]).toEqual({
				limit: DEFAULT_RUN_PAGE_LIMIT,
				offset: 0,
			});
		});

		test("every stated filter reaches the engine verbatim", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"list_runs",
				{
					limit: 10,
					offset: 20,
					type: "scenario",
					status: "failed",
					requestId: "req_1",
					collectionId: "col_1",
					q: "checkout",
					baseline: true,
				},
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "listRuns")[0]).toEqual({
				limit: 10,
				offset: 20,
				type: "scenario",
				status: "failed",
				requestId: "req_1",
				collectionId: "col_1",
				q: "checkout",
				baseline: true,
			});
		});

		test("baseline: false is forwarded, not dropped as falsy", async () => {
			// "only unpinned runs" is a filter the engine offers; reading `false`
			// as "unset" would silently answer with the pinned ones included.
			const client = fakeClient();
			await dispatchTool("list_runs", { baseline: false }, ctxWith(client));
			expect(forwarded(client, "listRuns")[0]).toMatchObject({ baseline: false });
		});

		test("a filter the caller did not state is absent, not undefined", async () => {
			const client = fakeClient();
			await dispatchTool("list_runs", { type: "design" }, ctxWith(client));
			const query = forwarded(client, "listRuns")[0] as Record<string, unknown>;
			expect("status" in query).toBe(false);
			expect("q" in query).toBe(false);
		});

		test("a limit past the engine's cap is refused, not clamped", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"list_runs",
				{ limit: MAX_ENGINE_PAGE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(String(MAX_ENGINE_PAGE_LIMIT));
			expect(client.listRuns).not.toHaveBeenCalled();
		});

		test("a negative offset is refused", async () => {
			const client = fakeClient();
			const res = await dispatchTool("list_runs", { offset: -1 }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(client.listRuns).not.toHaveBeenCalled();
		});

		test("a page with more behind it says so, with the next offset", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1" }, { id: "run_2" }], 57)),
			});
			const res = await dispatchTool("list_runs", { limit: 2 }, ctxWith(client));
			const text = res.content.map((c) => c.text).join("\n");
			expect(text).toMatch(/2 of 57 runs/);
			expect(text).toMatch(/offset: 2/);
		});

		test("a complete page carries no caveat", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1" }])),
			});
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			expect(res.content).toHaveLength(1);
			expect(firstText(res)).not.toMatch(/Bounded read/);
		});
	});

	describe("the stored-series reads", () => {
		test("each defaults to a page a context window can hold", async () => {
			const client = fakeClient();
			await dispatchTool("get_run_samples", { runId: "run_1" }, ctxWith(client));
			await dispatchTool("get_run_timeseries", { runId: "run_1" }, ctxWith(client));
			await dispatchTool("get_run_monitor", { runId: "run_1" }, ctxWith(client));
			expect(forwarded(client, "getRunSamples")).toEqual([
				"run_1",
				DEFAULT_RUN_SAMPLE_LIMIT,
				0,
				undefined,
			]);
			expect(forwarded(client, "getRunTimeSeries")).toEqual([
				"run_1",
				DEFAULT_RUN_SERIES_LIMIT,
				0,
				undefined,
			]);
			expect(forwarded(client, "getRunMonitorSeries")).toEqual([
				"run_1",
				DEFAULT_RUN_SERIES_LIMIT,
				0,
				undefined,
			]);
		});

		test("stated pagination is forwarded", async () => {
			const client = fakeClient();
			await dispatchTool(
				"get_run_timeseries",
				{ runId: "run_1", limit: 250, offset: 500 },
				ctxWith(client)
			);
			expect(forwarded(client, "getRunTimeSeries")).toEqual(["run_1", 250, 500, undefined]);
		});

		test("the series cap is the tool's, well below the engine's 50000", async () => {
			const client = fakeClient();
			for (const tool of ["get_run_timeseries", "get_run_monitor"]) {
				const res = await dispatchTool(
					tool,
					{ runId: "run_1", limit: MAX_RUN_SERIES_LIMIT + 1 },
					ctxWith(client)
				);
				expect(res.isError, tool).toBe(true);
				expect(firstText(res)).toContain(String(MAX_RUN_SERIES_LIMIT));
			}
			expect(client.getRunTimeSeries).not.toHaveBeenCalled();
			expect(client.getRunMonitorSeries).not.toHaveBeenCalled();
		});

		test("samples stop at the engine's own cap", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"get_run_samples",
				{ runId: "run_1", limit: MAX_ENGINE_PAGE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(client.getRunSamples).not.toHaveBeenCalled();
		});

		test("non-positive pagination is refused on every read", async () => {
			const client = fakeClient();
			for (const [tool, args] of [
				["get_run_samples", { runId: "run_1", limit: 0 }],
				["get_run_timeseries", { runId: "run_1", offset: -5 }],
				["get_run_monitor", { runId: "run_1", limit: 2.5 }],
			] as const) {
				const res = await dispatchTool(tool, args, ctxWith(client));
				expect(res.isError, tool).toBe(true);
			}
			expect(client.getRunSamples).not.toHaveBeenCalled();
			expect(client.getRunTimeSeries).not.toHaveBeenCalled();
			expect(client.getRunMonitorSeries).not.toHaveBeenCalled();
		});

		test("a truncated page discloses what it left behind", async () => {
			const client = fakeClient({
				getRunSamples: vi.fn().mockResolvedValue(page([{ resultId: 1 }], 900, 25)),
			});
			const res = await dispatchTool(
				"get_run_samples",
				{ runId: "run_1", offset: 25 },
				ctxWith(client)
			);
			const text = res.content.map((c) => c.text).join("\n");
			expect(text).toMatch(/1 of 900 captured samples/);
			expect(text).toMatch(/offset: 26/);
		});

		test("a run the engine does not know is an engine error, not an empty page", async () => {
			const client = fakeClient({
				getRunTimeSeries: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Run not found")
					),
			});
			const res = await dispatchTool(
				"get_run_timeseries",
				{ runId: "gone" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/404/);
		});
	});

	describe("set_run_baseline", () => {
		test("is refused while writes are off", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"set_run_baseline",
				{ runId: "run_1", baseline: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.setRunBaseline).not.toHaveBeenCalled();
		});

		test("pins and unpins through the one tool", async () => {
			for (const baseline of [true, false]) {
				const client = fakeClient();
				const res = await dispatchTool(
					"set_run_baseline",
					{ runId: "run_1", baseline },
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBeFalsy();
				expect(client.setRunBaseline).toHaveBeenCalledWith("run_1", baseline, undefined);
			}
		});

		test("a missing or non-boolean baseline is an argument error", async () => {
			const client = fakeClient();
			for (const args of [{ runId: "run_1" }, { runId: "run_1", baseline: "true" }]) {
				const res = await dispatchTool(
					"set_run_baseline",
					args,
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toMatch(/baseline/);
			}
			expect(client.setRunBaseline).not.toHaveBeenCalled();
		});

		test("a pin is what compare_runs then resolves with no baseRunId", async () => {
			// The pair the issue is about: #472 built the resolution and never the
			// write, so the only way to pin was the app's own sidebar.
			let pinned: string | null = null;
			const client = fakeClient({
				setRunBaseline: vi.fn(async (runId: string, baseline: boolean) => {
					pinned = baseline ? runId : null;
					return { id: runId, baseline };
				}),
				listBaselineRuns: vi.fn(async () => ({ data: pinned ? [{ id: pinned }] : [] })),
			});
			const ctx = ctxWith(client, { allowWrites: true });

			const unpinned = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctx);
			expect(unpinned.isError).toBe(true);

			await dispatchTool("set_run_baseline", { runId: "run_a", baseline: true }, ctx);
			const compared = await dispatchTool("compare_runs", { targetRunId: "run_b" }, ctx);
			expect(compared.isError).toBeFalsy();
			expect(compared.structuredContent).toMatchObject({
				baseRunId: "run_a",
				targetRunId: "run_b",
			});
		});

		test("is not hinted destructive - it is undone by calling it again", () => {
			const tool = TOOLS.find((t) => t.name === "set_run_baseline");
			expect(tool?.category).toBe("write");
			expect(tool?.annotations.destructiveHint).toBe(false);
			expect(tool?.annotations.idempotentHint).toBe(true);
		});
	});

	describe("delete_run", () => {
		test("is refused while writes are off, without even reading the run", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_1", confirmed: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.getRun).not.toHaveBeenCalled();
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		test("names the run in its preview and deletes nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("load run run_b");
			expect(firstText(res)).toContain("https://api.example.com/users");
			// Epoch milliseconds are rendered, not printed at a human.
			expect(firstText(res)).toContain("2025-08-12T");
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		test("deletes once confirmed", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.deleteRun).toHaveBeenCalledWith("run_b", undefined);
		});

		test("answers a missing id as such, not as a transport failure", async () => {
			const client = fakeClient({
				getRun: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Run not found")
					),
			});
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_gone", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("run_gone");
			expect(client.deleteRun).not.toHaveBeenCalled();
		});

		test("a run still stopping is reported as not deleted, with the retry", async () => {
			// The engine refuses rather than half-deletes a run whose worker is
			// still writing. Reported as a generic engine error, an agent would
			// read "409" and could not tell whether the run survived.
			const client = fakeClient({
				deleteRun: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 409", 409, "still stopping")
					),
			});
			const res = await dispatchTool(
				"delete_run",
				{ runId: "run_b", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/NOT deleted/);
			expect(firstText(res)).toMatch(/again/i);
		});
	});
});

describe("webhook inbox tools", () => {
	const byName = () => new Map(TOOLS.map((t) => [t.name, t]));
	const forwarded = (client: EngineClient, method: keyof EngineClient) =>
		(client[method] as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");

	describe("the loopback guarantee", () => {
		test("no inbox payload can carry a bind or a non-loopback confirmation", async () => {
			// The mutation check for epic #753's stated non-goal: an inbox MCP
			// started must not be reachable off this machine. Asserted as the
			// *absence* of both fields, whatever the caller sent - the engine only
			// leaves loopback when it is asked to, so never asking is the guard.
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ port: 45001, bind: "0.0.0.0", confirmNonLoopback: true },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			const payload = forwarded(client, "startInbox")[0] as Record<string, unknown>;
			expect(payload).not.toHaveProperty("bind");
			expect(payload).not.toHaveProperty("confirmNonLoopback");
			expect(payload).toEqual({ port: 45001 });
		});

		test("the schema does not offer a bind at all", () => {
			const schema = byName().get("start_webhook_inbox")?.inputSchema ?? {};
			expect(Object.keys(schema).sort()).toEqual(["port", "response"]);
		});
	});

	describe("start_webhook_inbox", () => {
		test("forwards only the canned-response fields the caller named", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ response: { status: 202, body: "queued", delayMs: 250 } },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			// An absent field must stay absent: `PUT /inbox/:id` is a merge-patch
			// and a spelled-out null is "reset this", not "unspecified".
			expect(forwarded(client, "startInbox")[0]).toEqual({
				response: { status: 202, body: "queued", delayMs: 250 },
			});
		});

		test("needs no write toggle - it saves nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_webhook_inbox",
				{},
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBeFalsy();
			expect(client.startInbox).toHaveBeenCalled();
		});
	});

	describe("get_inbox_captures", () => {
		test("stated pagination is forwarded", async () => {
			const client = fakeClient();
			await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", limit: 50, offset: 100 },
				ctxWith(client)
			);
			expect(forwarded(client, "getInboxCaptures")).toEqual(["inbox_1", 50, 100, undefined]);
		});

		test("with no pagination it asks for the documented default page", async () => {
			const client = fakeClient();
			await dispatchTool("get_inbox_captures", { inboxId: "inbox_1" }, ctxWith(client));
			expect(forwarded(client, "getInboxCaptures")).toEqual([
				"inbox_1",
				DEFAULT_INBOX_CAPTURE_LIMIT,
				0,
				undefined,
			]);
		});

		test("a page beyond the tool's cap is refused, not clamped", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", limit: MAX_INBOX_CAPTURE_LIMIT + 1 },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(String(MAX_INBOX_CAPTURE_LIMIT));
			expect(client.getInboxCaptures).not.toHaveBeenCalled();
		});

		test("non-positive pagination is refused", async () => {
			const client = fakeClient();
			for (const args of [
				{ inboxId: "inbox_1", limit: 0 },
				{ inboxId: "inbox_1", offset: -1 },
			]) {
				const res = await dispatchTool("get_inbox_captures", args, ctxWith(client));
				expect(res.isError).toBe(true);
			}
			expect(client.getInboxCaptures).not.toHaveBeenCalled();
		});

		test("a truncated page discloses what it left behind", async () => {
			const client = fakeClient({
				getInboxCaptures: vi
					.fn()
					.mockResolvedValue(page([{ id: 9, method: "POST" }], 400, 25)),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1", offset: 25 },
				ctxWith(client)
			);
			expect(allText(res)).toMatch(/1 of 400 captures/);
			expect(allText(res)).toMatch(/offset: 26/);
		});

		test("a capture body past the inline bound is cut and says so", async () => {
			// A webhook can post megabytes; the engine stores up to
			// `inboxMaxBodyBytes` of it, which is configurable well past what a
			// tool result can carry (issue #767's case, arriving by another route).
			const body = "x".repeat(MAX_INLINE_BODY_BYTES + 500);
			const client = fakeClient({
				getInboxCaptures: vi.fn().mockResolvedValue(
					page([
						{ id: 1, method: "POST", body, bodyBytes: body.length },
						{ id: 2, method: "POST", body: "small", bodyBytes: 5 },
					])
				),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client)
			);
			const captures = (JSON.parse(firstText(res)) as { data: Record<string, unknown>[] })
				.data;
			expect((captures[0].body as string).length).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(captures[0].bodyTruncated).toBe(true);
			// The engine's own count of the original size survives the cut - a
			// smaller number here would look just as real and be wrong.
			expect(captures[0].bodyBytes).toBe(body.length);
			// Under the bound nothing is touched, flag included.
			expect(captures[1]).toEqual({ id: 2, method: "POST", body: "small", bodyBytes: 5 });
		});

		test("an unknown inbox is an engine error, not an empty page", async () => {
			const client = fakeClient({
				getInboxCaptures: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Inbox not found")
					),
			});
			const res = await dispatchTool(
				"get_inbox_captures",
				{ inboxId: "gone" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/404/);
		});
	});

	describe("stop_webhook_inbox", () => {
		test("stops without the write toggle, and keeps the captures", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"stop_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBeFalsy();
			expect(client.stopInbox).toHaveBeenCalledWith("inbox_1", undefined);
			expect(client.deleteInbox).not.toHaveBeenCalled();
			// The distinction an agent has to be able to read off the tool list.
			expect(byName().get("stop_webhook_inbox")?.description).toMatch(/NOT a delete/);
		});
	});

	describe("delete_webhook_inbox", () => {
		test("is refused while writes are off, without even reading the inbox", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1", confirmed: true },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.listInboxes).not.toHaveBeenCalled();
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});

		test("the preview names the real capture count and deletes nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).toMatch(/awaiting confirmation/i);
			expect(firstText(res)).toContain("3 captured requests");
			expect(firstText(res)).toContain("http://127.0.0.1:45001");
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});

		test("an empty inbox says so rather than leaving the count unstated", async () => {
			const client = fakeClient({
				listInboxes: vi.fn().mockResolvedValue({
					data: [{ inboxId: "inbox_1", url: "http://127.0.0.1:45001", running: false }],
				}),
			});
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain("0 captured requests");
			expect(firstText(res)).toContain("stopped");
		});

		test("deletes once confirmed", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_1", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.deleteInbox).toHaveBeenCalledWith("inbox_1", undefined);
		});

		test("an id the engine does not list is an argument error, not a delete", async () => {
			const client = fakeClient({ listInboxes: vi.fn().mockResolvedValue({ data: [] }) });
			const res = await dispatchTool(
				"delete_webhook_inbox",
				{ inboxId: "inbox_gone", confirmed: true },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("inbox_gone");
			expect(client.deleteInbox).not.toHaveBeenCalled();
		});
	});

	describe("clear_inbox_captures", () => {
		test("is refused while writes are off", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"clear_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.clearInboxCaptures).not.toHaveBeenCalled();
		});

		test("clears with the toggle on, and needs no confirmation", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"clear_inbox_captures",
				{ inboxId: "inbox_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(client.clearInboxCaptures).toHaveBeenCalledWith("inbox_1", undefined);
		});
	});

	describe("update_inbox_response", () => {
		test("sends only the named fields, so the rest keep their live values", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_inbox_response",
				{ inboxId: "inbox_1", status: 503, delayMs: 0 },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "updateInboxResponse")).toEqual([
				"inbox_1",
				{ status: 503, delayMs: 0 },
				undefined,
			]);
		});

		test("a patch naming no field is refused instead of reported as applied", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_inbox_response",
				{ inboxId: "inbox_1" },
				ctxWith(client)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/status/);
			expect(client.updateInboxResponse).not.toHaveBeenCalled();
		});
	});

	describe("categories and hints", () => {
		test("the reads are reads, the listeners execute, and the two deletes write", () => {
			const tools = byName();
			expect(tools.get("list_webhook_inboxes")?.category).toBe("read");
			expect(tools.get("get_inbox_captures")?.category).toBe("read");
			expect(tools.get("start_webhook_inbox")?.category).toBe("execute");
			expect(tools.get("stop_webhook_inbox")?.category).toBe("execute");
			expect(tools.get("update_inbox_response")?.category).toBe("execute");
			// Both destroy recorded data, so both sit behind the write toggle.
			expect(tools.get("delete_webhook_inbox")?.category).toBe("write");
			expect(tools.get("clear_inbox_captures")?.category).toBe("write");
			expect(tools.get("delete_webhook_inbox")?.annotations.destructiveHint).toBe(true);
			expect(tools.get("clear_inbox_captures")?.annotations.destructiveHint).toBe(true);
			// A stop loses nothing, and neither reaches off the machine.
			expect(tools.get("stop_webhook_inbox")?.annotations.destructiveHint).toBe(false);
			for (const name of [
				"start_webhook_inbox",
				"list_webhook_inboxes",
				"stop_webhook_inbox",
				"delete_webhook_inbox",
				"get_inbox_captures",
				"clear_inbox_captures",
				"update_inbox_response",
			]) {
				expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			}
		});

		test("no tool offers the live SSE stream - polling the captures is the shape", () => {
			// Single-watcher engine-side (a second is a 409), and the app's own
			// inbox tab may hold it. Locked as a decision rather than an omission.
			expect(
				TOOLS.map((t) => t.name).filter((n) => /inbox.*live|live.*inbox/.test(n))
			).toEqual([]);
			expect(byName().get("get_inbox_captures")?.description).toMatch(/no live stream/i);
		});
	});
});

/**
 * The run-recording knobs the app's load dialog has always sent, reachable over
 * MCP for the first time (issue #760).
 *
 * The load-bearing assertions are the payload *keys*: these three are the only
 * snake_case fields on `POST /runs`, and a camelCase spelling reaches the engine
 * as an unread key rather than an error - a knob an agent believes it set and no
 * run ever reads.
 */
describe("start_load_run recording knobs", () => {
	const allow = { allowlist: ["api.example.com"] };
	const started = (client: EngineClient) =>
		(client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;

	async function start(args: Record<string, unknown>, client = fakeClient()) {
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true, ...args },
			ctxWith(client, allow)
		);
		return { res, client };
	}

	test("each knob travels under the engine's own key", async () => {
		const { res, client } = await start({
			successSamplePeriod: 5,
			slowRequestThresholdMs: 750,
			saveTimingBreakdown: true,
			comment: "nightly baseline",
		});

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			success_sample_rate: 5,
			slow_threshold_ms: 750,
			save_timing_breakdown: true,
			comment: "nightly baseline",
		});
		// The camelCase argument names must not also reach the engine: it reads
		// the snake_case ones and would ignore these in silence.
		for (const camel of [
			"successSamplePeriod",
			"slowRequestThresholdMs",
			"saveTimingBreakdown",
		]) {
			expect(started(client)).not.toHaveProperty(camel);
		}
	});

	test("a knob the caller did not name is absent, not defaulted", async () => {
		const { client } = await start({ comment: "just a note" });
		const payload = started(client);

		// Each has an engine-side default a stated value would overwrite; a
		// defaulted `save_timing_breakdown: false` here would switch off tracing
		// for a caller that never mentioned it.
		for (const key of ["success_sample_rate", "slow_threshold_ms", "save_timing_breakdown"]) {
			expect(payload).not.toHaveProperty(key);
		}
	});

	test("a sampling period of 0 is refused at the schema, not sent as a divide by zero", () => {
		const schema = z.object(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as z.ZodRawShape
		);
		expect(schema.safeParse({ successSamplePeriod: 0 }).success).toBe(false);
		expect(schema.safeParse({ successSamplePeriod: 1 }).success).toBe(true);
		expect(
			schema.safeParse({ successSamplePeriod: MAX_SUCCESS_SAMPLE_PERIOD + 1 }).success
		).toBe(false);
		// 0 disables outlier capture and is legal; a negative would mark every
		// completion an outlier.
		expect(schema.safeParse({ slowRequestThresholdMs: 0 }).success).toBe(true);
		expect(schema.safeParse({ slowRequestThresholdMs: -1 }).success).toBe(false);
		expect(
			schema.safeParse({ slowRequestThresholdMs: MAX_SLOW_THRESHOLD_MS + 1 }).success
		).toBe(false);
	});

	/**
	 * `POST /runs` has no guard on `maxRedirects` - it reaches
	 * `CURLOPT_MAXREDIRS`, where a negative means *unlimited* - so this schema is
	 * the only thing between `-1` and a run that follows chains forever.
	 */
	test("the redirect policy reaches composition, and a negative ceiling is refused", async () => {
		const { client } = await start({ followRedirects: false, maxRedirects: 3 });
		const composed = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			request: Record<string, unknown>;
		};

		expect(composed.request).toMatchObject({ followRedirects: false, maxRedirects: 3 });

		const schema = z.object(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as z.ZodRawShape
		);
		expect(schema.safeParse({ maxRedirects: -1 }).success).toBe(false);
		expect(schema.safeParse({ maxRedirects: 0 }).success).toBe(true);
		expect(schema.safeParse({ maxRedirects: MAX_REDIRECTS_BOUND + 1 }).success).toBe(false);
	});

	/**
	 * Both executors read them off the same `RunContext`, so forwarding on one
	 * path only would be a knob that silently does nothing on the other.
	 */
	test("a scenario load run carries the same knobs", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "req_1", name: "Step", order: 0 }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/step" }),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "col_1" },
				confirmed: true,
				successSamplePeriod: 2,
				slowRequestThresholdMs: 900,
				saveTimingBreakdown: true,
				comment: "scenario soak",
			},
			ctxWith(client, allow)
		);

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			success_sample_rate: 2,
			slow_threshold_ms: 900,
			save_timing_breakdown: true,
			comment: "scenario soak",
		});
	});

	test("a scenario run refuses the redirect policy by name - each step keeps its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "col_1" }, confirmed: true, followRedirects: true },
			ctxWith(client, allow)
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/followRedirects/);
		expect(firstText(res)).toMatch(/stored redirect policy/i);
		expect(client.startRun).not.toHaveBeenCalled();
	});
});

/**
 * The OAuth 2.0 token-cache tools (issue #760).
 *
 * Two rules carry the weight here and both are security-shaped: the interactive
 * grant is refused *before* the engine is called, and no tool ever returns the
 * access token's bytes.
 */
describe("OAuth 2.0 token tools", () => {
	const config = {
		grantType: "client_credentials",
		accessTokenUrl: "https://id.example.com/oauth/token",
		clientId: "client_a",
		clientSecret: "s3cret",
	};
	const allow = { allowlist: ["id.example.com"] };

	test("the three tools sit in the categories their effects call for", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		// It contacts a third party; it does not mutate saved documents.
		expect(tools.get("fetch_oauth2_token")?.category).toBe("execute");
		expect(tools.get("fetch_oauth2_token")?.annotations.openWorldHint).toBe(true);
		expect(tools.get("get_oauth2_token_status")?.category).toBe("read");
		// It destroys a stored credential, so it sits behind the write toggle -
		// the same place `clear_cookies` sits for the same reason.
		expect(tools.get("clear_oauth2_token")?.category).toBe("write");
	});

	test("fetch acquires the token and never hands back the bearer", async () => {
		const client = fakeClient();
		const res = await dispatchTool("fetch_oauth2_token", { config }, ctxWith(client, allow));

		expect(res.isError).toBeFalsy();
		expect(client.fetchOAuth2Token).toHaveBeenCalledTimes(1);
		expect((client.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
			config,
		});
		const text = firstText(res);
		expect(text).not.toContain(OAUTH2_TOKEN_RECORD.accessToken);
		// What an agent legitimately needs from the cache is its shape - the key
		// it can inspect and clear by, and when it expires.
		expect(JSON.parse(text)).toEqual({
			cacheKey: OAUTH2_TOKEN_RECORD.cacheKey,
			tokenType: "Bearer",
			scope: "orders:read",
			expiresIn: 3600,
			createdAt: OAUTH2_TOKEN_RECORD.createdAt,
			expiresAt: OAUTH2_TOKEN_RECORD.expiresAt,
			hasRefreshToken: true,
			// Stated rather than silently omitted: an agent that finds no token
			// and is not told why concludes the acquisition half-failed.
			accessTokenWithheld: true,
		});
	});

	test("force is forwarded only when asked for", async () => {
		const forced = fakeClient();
		await dispatchTool("fetch_oauth2_token", { config, force: true }, ctxWith(forced, allow));
		expect(
			(forced.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]
		).toMatchObject({ force: true });

		const plain = fakeClient();
		await dispatchTool("fetch_oauth2_token", { config, force: false }, ctxWith(plain, allow));
		// A stated `false` is the engine's own default, and sending it would make
		// "the caller said no" indistinguishable from "the caller said nothing".
		expect(
			(plain.fetchOAuth2Token as ReturnType<typeof vi.fn>).mock.calls[0][0]
		).not.toHaveProperty("force");
	});

	/**
	 * The refusal is not merely "it cannot work". `acquire_token` answers a cache
	 * hit *before* it looks at the grant, so a call naming a config that matches
	 * an entry the user authorized in a browser would otherwise reach into it.
	 */
	test("the authorization_code grant is refused before the engine is called", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"fetch_oauth2_token",
			{ config: { ...config, grantType: "authorization_code" } },
			ctxWith(client, allow)
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/authorization_code/);
		// The refusal names where the user can do it instead.
		expect(firstText(res)).toMatch(/Auth tab|in Vayu/i);
		expect(client.fetchOAuth2Token).not.toHaveBeenCalled();
	});

	test("the token endpoint is gated by the allowlist, and so is a different refresh host", async () => {
		const blocked = fakeClient();
		const off = await dispatchTool("fetch_oauth2_token", { config }, ctxWith(blocked));
		expect(off.isError).toBe(true);
		expect(firstText(off)).toMatch(/accessTokenUrl/);
		expect(blocked.fetchOAuth2Token).not.toHaveBeenCalled();

		// A config whose refresh URL points somewhere else must not walk around
		// the gate the token URL passed.
		const sneaky = fakeClient();
		const res = await dispatchTool(
			"fetch_oauth2_token",
			{ config: { ...config, refreshTokenUrl: "https://elsewhere.example.net/refresh" } },
			ctxWith(sneaky, allow)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/refreshTokenUrl/);
		expect(sneaky.fetchOAuth2Token).not.toHaveBeenCalled();
	});

	test("status reports presence and expiry without the bearer", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"get_oauth2_token_status",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(client.getOAuth2TokenStatus).toHaveBeenCalledWith(
			OAUTH2_TOKEN_RECORD.cacheKey,
			undefined
		);
		const text = firstText(res);
		expect(text).toContain('"found": true');
		expect(text).toContain('"expired": false');
		expect(text).not.toContain(OAUTH2_TOKEN_RECORD.accessToken);
	});

	test("an absent entry is an answer, not an error", async () => {
		const client = fakeClient({
			getOAuth2TokenStatus: vi.fn().mockResolvedValue({ found: false }),
		});
		const res = await dispatchTool(
			"get_oauth2_token_status",
			{ cacheKey: "nothing-here" },
			ctxWith(client)
		);

		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toContain('"found": false');
	});

	test("clearing is refused while writes are off, and reports what it removed when on", async () => {
		const gated = fakeClient();
		const refused = await dispatchTool(
			"clear_oauth2_token",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(gated)
		);
		expect(refused.isError).toBe(true);
		expect(firstText(refused)).toMatch(/writes are disabled/i);
		expect(gated.clearOAuth2Token).not.toHaveBeenCalled();

		const client = fakeClient();
		const res = await dispatchTool(
			"clear_oauth2_token",
			{ cacheKey: OAUTH2_TOKEN_RECORD.cacheKey },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.clearOAuth2Token).toHaveBeenCalledWith(
			OAUTH2_TOKEN_RECORD.cacheKey,
			undefined
		);
		expect(firstText(res)).toContain('"deleted": true');
	});

	test("the cache families the renderer must refetch are declared", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		// Both change what the auth tab's status row shows; a read changes nothing.
		expect(tools.get("fetch_oauth2_token")?.invalidates).toEqual(["oauth"]);
		expect(tools.get("clear_oauth2_token")?.invalidates).toEqual(["oauth"]);
		expect(tools.get("get_oauth2_token_status")?.invalidates).toEqual([]);
	});
});

/**
 * OpenAPI spec binding, phase A (issue #761).
 *
 * Two things are worth locking here, and neither is the passthrough.
 *
 * The first is that describing a binding must not transfer the document. That
 * is the whole reason `GET /specs/:id/meta` exists (#712) - a real spec is
 * megabytes, and one in a tool result exceeds the result token limit outright -
 * so the tests assert *which route was called*, not just what came back. A
 * version that read the full document and dropped `content` would answer
 * identically and cost the same megabytes.
 *
 * The third is that `export_spec` is a read that bounds what it hands back: an
 * exported document is as large as the stored one, so the text is capped like
 * every other body an agent sees (#767) and `contentBytes` says what the cap is
 * a prefix of.
 *
 * The second is that `unbind_spec` writes `openapi: null` and never `{}`. The
 * engine reads an absent field as "keep" and null as "reset to the default";
 * `{}` is a value that happens to serialize as unbound today, and the two would
 * drift the first time the default changed. The Spec tab's Unbind sends null for
 * the same reason.
 */
describe("OpenAPI spec binding tools", () => {
	const WRITES = { allowWrites: true };
	const allText = (r: { content: Array<{ text: string }> }) =>
		r.content.map((c) => c.text).join("\n");

	/** A collection row bound to `spec_1`, as the engine serializes one. */
	const boundCollection = {
		id: "col_1",
		name: "API",
		openapi: { specId: "spec_1", specHash: "abc123", syncedAt: 1_755_000_000_000 },
	};

	/** The unbound state as the engine stores it: an empty object, not absent. */
	const unboundCollection = { id: "col_1", name: "API", openapi: {} };

	test("get_spec resolves a collection's binding and reads metadata, not the document", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool("get_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(client.getSpecMeta).toHaveBeenCalledWith("spec_1", undefined);
		// The document itself is never fetched for a metadata read - the point.
		expect(client.getSpec).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			specId: "spec_1",
			bound: true,
			collectionId: "col_1",
			sourceUrl: "https://api.example.com/openapi.json",
			hash: "abc123",
			contentBytes: 4,
			binding: { specId: "spec_1", specHash: "abc123" },
		});
		expect(value).not.toHaveProperty("content");
	});

	test("get_spec reads a spec by id without touching collections", async () => {
		const client = fakeClient();
		const res = await dispatchTool("get_spec", { specId: "spec_9" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(client.getCollection).not.toHaveBeenCalled();
		expect(client.getSpecMeta).toHaveBeenCalledWith("spec_9", undefined);
		// No collection was named, so there is no binding to report - the field is
		// absent rather than null, which would read as "bound to nothing".
		expect(JSON.parse(firstText(res))).not.toHaveProperty("binding");
	});

	test("an unbound collection is an answer, not an error, and reads no spec", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(unboundCollection),
		});
		const res = await dispatchTool("get_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual({ collectionId: "col_1", bound: false });
		expect(client.getSpecMeta).not.toHaveBeenCalled();
		expect(allText(res)).toMatch(/not bound/i);
	});

	test("get_spec refuses no selector and both selectors", async () => {
		const client = fakeClient();
		const neither = await dispatchTool("get_spec", {}, ctxWith(client));
		expect(neither.isError).toBe(true);
		const both = await dispatchTool(
			"get_spec",
			{ collectionId: "col_1", specId: "spec_1" },
			ctxWith(client)
		);
		expect(both.isError).toBe(true);
		expect(firstText(both)).toMatch(/not both/i);
		expect(client.getSpecMeta).not.toHaveBeenCalled();
	});

	test("get_spec names a collection id nothing matches", async () => {
		const client = fakeClient({ getCollection: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool("get_spec", { collectionId: "nope" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("nope");
		expect(client.getSpecMeta).not.toHaveBeenCalled();
	});

	test("includeContent reads the document and caps it, reporting the true size", async () => {
		const document = "x".repeat(MAX_INLINE_BODY_BYTES * 2);
		const client = fakeClient({
			getSpec: vi.fn().mockResolvedValue({
				id: "spec_1",
				content: document,
				sourceUrl: null,
				fetchedAt: 1,
				hash: "h",
			}),
		});
		const res = await dispatchTool(
			"get_spec",
			{ specId: "spec_1", includeContent: true },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.getSpec).toHaveBeenCalledWith("spec_1", undefined);
		expect(client.getSpecMeta).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.content as string, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.contentTruncated).toBe(true);
		// The full read carries no `contentBytes`, so the true size has to be
		// measured here - a cut that reported its own length would tell an agent
		// the spec is 32 KB.
		expect(value.contentBytes).toBe(document.length);
		expect(value.sourceUrl).toBeNull();
	});

	test("export_spec asks the engine for the document and passes its notes through", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_spec",
			{ collectionId: "col_1", format: "yaml" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "yaml", undefined);
		// The assembly is the engine's, so nothing here reads the collection, its
		// requests or the document it is bound to - one call is the whole tool.
		expect(client.listRequests).not.toHaveBeenCalled();
		expect(client.getSpec).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			collectionId: "col_1",
			format: "yaml",
			fileName: "api.openapi.json",
			documentTruncated: false,
		});
		expect(value.notes.direction).toBe("document");
		expect(value.document).toContain("openapi");
	});

	test("export_spec defaults to JSON and caps a document too large to hand back whole", async () => {
		const document = `{"openapi":"3.1.0","x":"${"a".repeat(MAX_INLINE_BODY_BYTES)}"}`;
		const client = fakeClient({
			exportSpec: vi
				.fn()
				.mockResolvedValue({ text: document, fileName: "api.openapi.json", notes: {} }),
		});
		const res = await dispatchTool("export_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "json", undefined);
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.document, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.documentTruncated).toBe(true);
		// The cut says what it is a prefix of - a length read off the truncated
		// text would tell an agent the document is 32 KB.
		expect(value.contentBytes).toBe(document.length);
	});

	test("export_spec passes the engine's refusal through rather than inventing one", async () => {
		// A binding whose document is not stored is a 409 with a sentence naming
		// it - the one answer a caller can act on, so it is not reworded here.
		const client = fakeClient({
			exportSpec: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						"Collection is bound to spec 'spec_1', which is not stored"
					)
				),
		});
		const res = await dispatchTool("export_spec", { collectionId: "col_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("spec_1");
	});

	test("diff_spec sends the candidate document and nothing it could compare wrongly", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: '{"openapi":"3.1.0"}' },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		// Neither the requests nor the bound document ride in the payload: the
		// engine walks the subtree and reads the binding itself, so a caller
		// cannot make a stale copy the "previous" side of a three-way compare.
		expect(client.diffSpec).toHaveBeenCalledWith(
			{ collectionId: "col_1", spec: { content: '{"openapi":"3.1.0"}' } },
			undefined
		);
		expect(client.listRequests).not.toHaveBeenCalled();
		expect(client.getSpec).not.toHaveBeenCalled();
		expect(client.getCollection).not.toHaveBeenCalled();

		const value = JSON.parse(firstText(res));
		expect(value.identical).toBe(false);
		expect(value.summary).toEqual({
			added: 1,
			removed: 1,
			changed: 1,
			unchanged: 12,
			unmapped: 1,
		});
		expect(value.added[0].operation.operationId).toBe("listOwners");
		expect(value.removed[0].requestId).toBe("req_9");
		expect(value.changed[0].fields[0]).toMatchObject({
			field: "name",
			current: "List pets",
			next: "List all the pets",
			userTouched: false,
		});
		expect(value.entriesTruncated).toBe(false);
		// Reads only, and the caveat says so rather than leaving an agent to
		// assume a diff applied something.
		expect(allText(res)).toContain("Nothing was written");
	});

	test("diff_spec drops the drafts the engine attaches to every entry", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		// `draft` is what an apply *would* write, and `POST /specs/sync` re-reads
		// it off the document being stored rather than being handed it - so no
		// reader on either side of this tool consumes it. Passing it through
		// would be the heaviest field in the answer and the "written but never
		// read" defect at once. The rendered current/next pair, which is what
		// says *what* moved, survives - asserted above.
		expect(firstText(res)).not.toContain("draft");
		expect(firstText(res)).not.toContain("{{baseUrl}}");
	});

	test("diff_spec names the fields a person edited, and stays quiet when none were", async () => {
		const edited = {
			identical: false,
			added: [],
			removed: [],
			changed: [
				{
					requestId: "req_1",
					name: "List pets",
					operation: { operationId: "listPets", method: "GET", path: "/pets" },
					matchedBy: "operationId",
					renamed: false,
					previousUnknown: false,
					fields: [{ field: "url", current: "{{host}}/pets", next: "{{baseUrl}}/pets" }],
				},
			],
			unchanged: 0,
			unmapped: 0,
		};
		const untouched = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(fakeClient({ diffSpec: vi.fn().mockResolvedValue(edited) }))
		);
		// The flag rides on every field either way; what must not appear is the
		// warning, which is about fields somebody actually edited.
		expect(allText(untouched)).not.toContain("overwrites a person's work");

		// The same drift with the flag set is the one an agent must not propose
		// applying silently, so it is named rather than left inside the JSON.
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				...edited,
				changed: [
					{
						...edited.changed[0],
						fields: [{ ...edited.changed[0].fields[0], userTouched: true }],
					},
				],
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		expect(allText(res)).toContain("userTouched");
		expect(allText(res)).toContain("overwrites a person's work");
		expect(JSON.parse(firstText(res)).changed[0].fields[0].userTouched).toBe(true);
	});

	test("diff_spec says a byte-identical document has nothing to apply", async () => {
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				identical: true,
				added: [],
				removed: [],
				changed: [],
				unchanged: 14,
				unmapped: 0,
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(value.identical).toBe(true);
		expect(value.summary).toEqual({
			added: 0,
			removed: 0,
			changed: 0,
			unchanged: 14,
			unmapped: 0,
		});
		expect(allText(res)).toContain("byte-identical");
	});

	test("diff_spec caps each bucket and keeps the counts true", async () => {
		const over = MAX_SPEC_DIFF_ENTRIES + 7;
		const client = fakeClient({
			diffSpec: vi.fn().mockResolvedValue({
				identical: false,
				added: Array.from({ length: over }, (_unused, index) => ({
					operation: { operationId: `op_${index}`, method: "GET", path: `/p${index}` },
					folder: "",
				})),
				removed: [],
				changed: [],
				unchanged: 0,
				unmapped: 0,
			}),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(value.added).toHaveLength(MAX_SPEC_DIFF_ENTRIES);
		// The count an agent reads to decide whether a contract drifted is the
		// engine's, never the cut list's length - a total read off the list
		// would report 50 additions for a document that made 57.
		expect(value.summary.added).toBe(over);
		expect(value.entriesTruncated).toBe(true);
		expect(allText(res)).toContain(`capped at ${MAX_SPEC_DIFF_ENTRIES}`);
	});

	test("diff_spec passes the engine's refusal through rather than inventing one", async () => {
		// A collection that binds nothing has no middle term for the three-way
		// comparison, and the engine's sentence already says what to do about it.
		const client = fakeClient({
			diffSpec: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						"Collection 'col_1' is not bound to a spec; bind it before asking what a document would change"
					)
				),
		});
		const res = await dispatchTool(
			"diff_spec",
			{ collectionId: "col_1", content: "{}" },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("not bound to a spec");
	});

	test("unbind_spec is refused while writes are off, and reads nothing", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
		expect(client.getCollection).not.toHaveBeenCalled();
	});

	test("unbind_spec sends openapi: null and names the document it detached", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(boundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const [id, payload] = (client.updateCollection as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(id).toBe("col_1");
		// Null, not `{}` - see this block's header.
		expect(payload).toEqual({ openapi: null });
		expect(Object.prototype.hasOwnProperty.call(payload, "openapi")).toBe(true);
		expect((payload as { openapi: unknown }).openapi).toBeNull();
		expect(allText(res)).toContain("spec_1");
	});

	test("unbind_spec writes nothing for a collection that binds nothing", async () => {
		const client = fakeClient({
			getCollection: vi.fn().mockResolvedValue(unboundCollection),
		});
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "col_1" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateCollection).not.toHaveBeenCalled();
		expect(allText(res)).toMatch(/Nothing to do/i);
	});

	test("unbind_spec names a collection id nothing matches", async () => {
		const client = fakeClient({ getCollection: vi.fn().mockResolvedValue(null) });
		const res = await dispatchTool(
			"unbind_spec",
			{ collectionId: "nope" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(client.updateCollection).not.toHaveBeenCalled();
	});

	test("the categories and cache families are declared", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("get_spec")?.category).toBe("read");
		expect(tools.get("get_spec")?.invalidates).toEqual([]);
		// An export writes nothing and needs no write toggle: it is a read of what
		// the collection already is.
		expect(tools.get("export_spec")?.category).toBe("read");
		expect(tools.get("export_spec")?.invalidates).toEqual([]);
		expect(tools.get("export_spec")?.annotations.readOnlyHint).toBe(true);
		expect(tools.get("unbind_spec")?.category).toBe("write");
		// The Spec tab reads the binding off the collection row, so the family that
		// refetches collections is the one that refreshes it - no `spec` entity.
		expect(tools.get("unbind_spec")?.invalidates).toEqual(["collection"]);
		// Nothing it names is destroyed: the document stays and so do the stamps.
		expect(tools.get("unbind_spec")?.annotations.destructiveHint).toBe(false);
	});

	/*
	 * Binding (#862). Phase A deliberately shipped no bind tool, because a bind
	 * without operation matching stores a document with no index and leaves
	 * stale stamps uncleared - which makes coverage claim the wrong operation
	 * rather than none. Both halves moved engine-side (#853, #860), so the tool
	 * exists now and is one call to `POST /specs/bind`.
	 *
	 * What these cases hold is the two things the tool layer can get wrong: it
	 * must send the document and nothing it decided itself, and it must tell the
	 * agent about the identities the bind *removed* - the half a caller would
	 * otherwise learn about from a later run reporting no coverage.
	 */
	test("bind_spec is refused while writes are off, and writes nothing", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.bindSpec).not.toHaveBeenCalled();
	});

	test("bind_spec sends the document and no pairing of its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"bind_spec",
			{
				collectionId: "col_1",
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.yaml",
			},
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		const [payload] = (client.bindSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Exhaustive on purpose: an agent has no OpenAPI reader, and a `stamps`
		// or `clear` list appearing here would mean one had been written.
		expect(payload).toEqual({
			collectionId: "col_1",
			spec: {
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.yaml",
			},
		});
		expect(allText(res)).toContain("spec_2");
	});

	test("bind_spec omits sourceUrl for a document handed over as text", async () => {
		const client = fakeClient();
		await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const [payload] = (client.bindSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Absent, not null: the engine reads absent as "it did not come from a
		// URL", and a null would be a second spelling of the same thing.
		expect(Object.keys((payload as { spec: object }).spec)).toEqual(["content"]);
	});

	test("bind_spec says how many identities it removed, not only how many it wrote", async () => {
		const client = fakeClient({
			bindSpec: vi.fn().mockResolvedValue({
				specId: "spec_2",
				specHash: "def456",
				syncedAt: 1_755_000_100_000,
				stamped: 1,
				cleared: 2,
				unmatchedRequests: ["req_8", "req_9"],
				unmatchedOperations: [
					{ operationId: "getPet", method: "GET", path: "/pets/{petId}" },
				],
			}),
		});
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const text = allText(res);
		// The count a re-bind takes away is the one an agent acts on: it means
		// requests that were part of a contract are no longer part of this one.
		expect(text).toMatch(/Cleared identity from 2 requests/i);
		expect(text).toMatch(/Recorded identity on 1 request\./i);
		expect(text).toMatch(/2 requests matched no operation/i);
		expect(text).toMatch(/1 operation matched no request/i);
	});

	test("bind_spec reports an engine refusal rather than claiming a bind", async () => {
		const client = fakeClient({
			bindSpec: vi.fn().mockRejectedValue(new Error("Collection not found")),
		});
		const res = await dispatchTool(
			"bind_spec",
			{ collectionId: "nope", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		expect(allText(res)).not.toMatch(/Bound to spec/i);
	});

	test("sync_spec is refused when writes are disabled", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, { allowWrites: false })
		);
		expect(res.isError).toBe(true);
		expect(client.syncSpec).not.toHaveBeenCalled();
	});

	test("sync_spec asks for the safe policy and states no rows of its own", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: '{"openapi":"3.1.0"}' },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBeFalsy();
		/*
		 * The whole design of the tool, in one assertion (issue #871). Which of a
		 * drift is safe to write is `core::safe_spec_apply`, and a payload naming
		 * rows here would be a second opinion about which of a person's fields a
		 * sync may overwrite. Adding a `create` / `update` / `delete` section -
		 * or dropping the policy - reddens this.
		 */
		expect(client.syncSpec).toHaveBeenCalledWith(
			{
				collectionId: "col_1",
				spec: { content: '{"openapi":"3.1.0"}' },
				policy: "safe",
			},
			undefined
		);
		const [payload] = (client.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(Object.keys(payload as object).sort()).toEqual(["collectionId", "policy", "spec"]);
		// Nothing is worked out here either - no reading of the collection, no
		// diff of its own to decide from.
		expect(client.diffSpec).not.toHaveBeenCalled();
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("sync_spec says what the policy declined, not only what it wrote", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const text = allText(res);
		expect(text).toMatch(/1 request created, 2 requests updated, 0 requests deleted/i);
		/*
		 * The half an agent would otherwise assume did not exist. A caller that
		 * ticked nothing cannot see what it did not tick, so "2 updated" alone
		 * reads as "applied the drift" - and the two things left are a person's
		 * edit and a request the document dropped, which are exactly the two an
		 * agent must not conclude it has handled. Dropping the `skipped` sentence
		 * reddens this.
		 */
		expect(text).toMatch(/declined the rest/i);
		expect(text).toMatch(/1 changed request left untouched/i);
		expect(text).toMatch(/3 fields not written/i);
		expect(text).toMatch(/NOT deleted/);
		// And the counts are in the structured body too, not only in the prose.
		expect(JSON.parse(firstText(res)).skipped).toEqual({
			requests: 1,
			fields: 3,
			deletions: 1,
		});
	});

	test("sync_spec stays quiet about a policy that declined nothing", async () => {
		const client = fakeClient({
			syncSpec: vi.fn().mockResolvedValue({
				idMap: {},
				specId: "spec_3",
				specHash: "aaa",
				syncedAt: 1,
				created: 0,
				updated: 1,
				deleted: 0,
				skipped: { requests: 0, fields: 0, deletions: 0 },
			}),
		});
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		// A caveat that always warns is one nobody reads by the third call.
		expect(allText(res)).not.toMatch(/declined the rest/i);
	});

	test("sync_spec reports an engine refusal rather than claiming an apply", async () => {
		const client = fakeClient({
			syncSpec: vi
				.fn()
				.mockRejectedValue(
					new Error("Collection 'col_1' is not bound to a spec; bind it before syncing")
				),
		});
		const res = await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		expect(res.isError).toBe(true);
		// The engine's own sentence, which names the fix.
		expect(allText(res)).toMatch(/not bound to a spec/i);
		expect(allText(res)).not.toMatch(/Applied in one transaction/i);
	});

	test("sync_spec sends a sourceUrl only when it was given one", async () => {
		const client = fakeClient();
		await dispatchTool(
			"sync_spec",
			{ collectionId: "col_1", content: "openapi: 3.0.0" },
			ctxWith(client, WRITES)
		);
		const [bare] = (client.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		// Absent, not null: the engine reads absent as "it did not come from a
		// URL", the same reading `bind_spec` relies on.
		expect(Object.keys((bare as { spec: object }).spec)).toEqual(["content"]);

		const withUrl = fakeClient();
		await dispatchTool(
			"sync_spec",
			{
				collectionId: "col_1",
				content: "openapi: 3.0.0",
				sourceUrl: "https://api.example.com/openapi.json",
			},
			ctxWith(withUrl, WRITES)
		);
		const [stated] = (withUrl.syncSpec as ReturnType<typeof vi.fn>).mock.calls[0];
		expect((stated as { spec: { sourceUrl?: string } }).spec.sourceUrl).toBe(
			"https://api.example.com/openapi.json"
		);
	});

	test("sync_spec declares both families it changes", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("sync_spec")?.category).toBe("write");
		// The same set a bind uses: the document and the binding are collection
		// state, and the rows this creates, updates and deletes are requests.
		expect(tools.get("sync_spec")?.invalidates).toEqual(["collection", "request"]);
		expect(tools.get("sync_spec")?.annotations.idempotentHint).toBe(false);
	});

	test("bind_spec declares both families it changes", () => {
		const tools = new Map(TOOLS.map((t) => [t.name, t]));
		expect(tools.get("bind_spec")?.category).toBe("write");
		// Requests as well as collections: the binding is a collection field, but
		// the identity this writes and clears lives on the requests beneath it.
		expect(tools.get("bind_spec")?.invalidates).toEqual(["collection", "request"]);
		// Each call mints a new document row, so the same arguments twice is not
		// the same call twice.
		expect(tools.get("bind_spec")?.annotations.idempotentHint).toBe(false);
	});
});
