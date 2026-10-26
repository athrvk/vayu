/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { buildSchema, introspectionFromSchema } from "graphql";
import {
	DEFAULT_INBOX_CAPTURE_LIMIT,
	DEFAULT_RUN_SAMPLE_LIMIT,
	DEFAULT_RUN_SERIES_LIMIT,
	dispatchTool,
	INLINE_FILE_REFUSAL,
	INSECURE_TLS_REFUSAL,
	MAX_EXAMPLES_BODY_BYTES,
	MAX_INBOX_CAPTURE_LIMIT,
	MAX_IN_FLIGHT_BOUND,
	MAX_INLINE_BODY_BYTES,
	MAX_INTROSPECTION_BYTES,
	MAX_REDIRECTS_BOUND,
	MAX_REPORT_TRACE_BYTES,
	MAX_RESPONSE_SAMPLE_PERIOD,
	MAX_RESPONSE_SAMPLES_BOUND,
	MAX_RUN_SERIES_LIMIT,
	MAX_SCHEMA_SDL_BYTES,
	MAX_SLOW_THRESHOLD_MS,
	MAX_SPEC_DIFF_ENTRIES,
	MAX_SUCCESS_SAMPLE_PERIOD,
	ENGINE_DEFAULT_HEADERS_SENTENCE,
	REQUEST_SETTINGS_KEYS,
	resolveDescription,
	toolCatalog,
	TOOLS,
	type McpTool,
	type ToolContext,
	type ToolResult,
} from "./tools.js";
import type { McpHost } from "./tools/contract.js";
import { engineCode } from "./tools/failure.js";
import { composeLoadRunRequest } from "./tools/compose.js";
import { INPUT_REQUIRED } from "./tools/kit.js";
import { MCP_CAP_CEILINGS, resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { ENGINE_LOAD_DEFAULTS, LOAD_MODES } from "./safety.js";
import {
	ENVIRONMENT_DEFAULT_SENTENCE,
	VARIABLE_PRECEDENCE_SENTENCE,
	VARIABLE_RESOLUTION_URI,
} from "./variable-origins.js";
import {
	DEFAULT_LIST_PAGE_LIMIT,
	DEFAULT_RUN_PAGE_LIMIT,
	EngineRequestError,
	EngineTimeoutError,
	MAX_ENGINE_PAGE_LIMIT,
	type EngineClient,
} from "./engine-client.js";
import { defaultMcpExportFormat } from "./run-export-formats.js";
import { REVEAL_SETTING_TOKEN, resolveRemedyTokens } from "./remedy.js";
import { describeImport, describeImportPreview } from "./tools/spec-bindings.js";
import { REDACTED_MARKER, withheldPointer } from "./withhold.js";
import { LOAD_TEST_LIMITS, RESPONSE_SAMPLES_CEILING } from "@/constants/load-test";

/**
 * @p tool's description as a session under @p safety lists it - the defaults,
 * writes and reveal off, unless a case names otherwise. Throws for a missing
 * tool, so a renamed one fails here rather than passing a negative match.
 */
function descriptionOf(tool: McpTool | undefined, safety: Partial<McpSafetyConfig> = {}): string {
	if (!tool) throw new Error("tool is not registered");
	return resolveDescription(tool, resolveSafetyConfig(safety));
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

/** @p envelope as a paged read answers its last page: `nextOffset` null, no `note`. */
function lastPageAnswer(envelope: ReturnType<typeof page>) {
	return { ...envelope, pagination: { ...envelope.pagination, nextOffset: null } };
}

/**
 * A paged read's `pagination`, read from its one text block parsed as JSON,
 * after checking that parse agrees with `structuredContent`.
 */
function pageOf(res: { content: Array<{ text: string }>; structuredContent?: unknown }) {
	const parsed = JSON.parse(res.content[0].text) as { pagination: Record<string, unknown> };
	expect(res.structuredContent).toEqual(parsed);
	return parsed.pagination;
}

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

/**
 * An environments list holding `env_1`, for a test that scopes a send by it: a
 * send refuses an id no environment has (#2480). Inactive, so an omitted id
 * still composes with no environment.
 */
const listingEnv1 = () =>
	vi.fn().mockResolvedValue([{ id: "env_1", name: "Staging", isActive: false }]);

/** Build a fake EngineClient with vi.fn()s for the methods under test. */
function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
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

function ctxWith(
	client: EngineClient,
	safety?: Partial<McpSafetyConfig>,
	host: McpHost = "app"
): ToolContext {
	return { client, config: resolveSafetyConfig(safety), host };
}

const firstText = (r: { content: Array<{ text: string }> }) => r.content[0].text;

/** The engine's one error body shape, `{"error": {"code", "message"}}`. */
const engineErrorBody = (code: string, message: string) =>
	JSON.stringify({ error: { code, message } });

/** A context whose client can put a question to the person and answered @p answers. */
function ctxAsking(
	client: EngineClient,
	safety: Partial<McpSafetyConfig>,
	answers?: Record<string, unknown>
): ToolContext {
	return { ...ctxWith(client, safety), userInput: { responses: answers } };
}

/** The confirmation question a result asks the person, failing if it asks none. */
function askedQuestion(result: ToolResult): string {
	const pending = INPUT_REQUIRED.get(result);
	expect(pending).toBeDefined();
	const request = pending?.inputRequests?.confirm as { params: { message: string } };
	return request.params.message;
}

describe("tool registry", () => {
	test("exposes stable, unique tool names", () => {
		const names = TOOLS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain("run_request");
		expect(names).toContain("start_load_run");
		expect(names).toContain("compare_runs");
		expect(names).toContain("export_run_report");
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

	// Mutation check: restoring "it can differ slightly from the report's
	// summary.errorRate" in reads.tools.ts fails both assertions below.
	test("list_runs says its errorRate shares the report's failure definition, with no 'differ slightly' hedge", () => {
		const description = descriptionOf(TOOLS.find((t) => t.name === "list_runs"));
		expect(description).not.toBe("");
		expect(description).not.toContain("differ slightly");
		expect(description).toContain("same failure definition");
	});

	// Mutation check (#2820): drop the assertionsPassed / assertionsFailed
	// sentence from list_runs in reads.tools.ts and this fails.
	test("list_runs names the assertion counts a scenario load row carries and says errorRate excludes them", () => {
		const description = descriptionOf(TOOLS.find((t) => t.name === "list_runs"));
		expect(description).toContain("`assertionsPassed` and `assertionsFailed`");
		expect(description).toContain("never folded into errorRate");
		expect(description).toContain("omitted for every other run");
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

	/*
	 * The allowlist checks the host a request names, never the proxy it leaves
	 * through, so the proxy and trust-anchor keys get a gate of their own
	 * (#1805). Every key network.cpp seeds under it, plus a casing an engine
	 * key match might accept.
	 */
	test.each([
		"proxyUrl",
		"proxyMode",
		"proxySystemUrl",
		"proxyBypass",
		"customCaCertificates",
		"PROXYURL",
	])("update_engine_config refuses %s without the network gate", async (key) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "16", [key]: "http://evil.test:8080" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(key);
		expect(firstText(res)).toMatch(/Network settings/);
		// Refused whole: the ordinary key in the same batch is not applied either.
		expect(client.updateConfig).not.toHaveBeenCalled();
	});

	test("update_engine_config applies proxyUrl with the network gate on", async () => {
		const client = fakeClient();
		const entries = { proxyMode: "manual", proxyUrl: "http://proxy.corp:8080" };
		const res = await dispatchTool(
			"update_engine_config",
			{ entries },
			ctxWith(client, { allowWrites: true, allowNetworkSettings: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.updateConfig).toHaveBeenCalledWith({ entries }, undefined);
	});

	test("the network gate grants nothing without write access", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { proxyUrl: "http://proxy.corp:8080" } },
			ctxWith(client, { allowNetworkSettings: true })
		);
		expect(res.isError).toBe(true);
		expect(client.updateConfig).not.toHaveBeenCalled();
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
	test("create_request stores the pre-request and test scripts as elements", async () => {
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
		// The MCP argument is still named per-phase, but the wire field is
		// `elements` (issue #1514) - the engine refuses the old keys with a 400.
		// No `id` is sent: `apply_elements_field` stamps an `el_` one on.
		expect(payload).toMatchObject({
			elements: [
				{ kind: "script.pre", enabled: true, config: { script: pre } },
				{ kind: "script.post", enabled: true, config: { script: post } },
			],
		});
		expect(Object.keys(payload as object)).not.toContain("preRequestScript");
		expect(Object.keys(payload as object)).not.toContain("postRequestScript");
	});

	test("create_request sends no elements key when the caller named none", async () => {
		// The engine defaults an absent field to empty on a create; sending `[]`
		// anyway would make the payload claim the agent asked for an empty list.
		const client = fakeClient();
		await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "Plain", url: "https://api.example.com/x" },
			ctxWith(client, { allowWrites: true })
		);
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(Object.keys(payload as object)).not.toContain("preRequestScript");
		expect(Object.keys(payload as object)).not.toContain("postRequestScript");
		expect(Object.keys(payload as object)).not.toContain("elements");
	});

	test("create_request refuses both `elements` and script sugar on the same call", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Signed",
				url: "https://api.example.com/x",
				elements: [{ kind: "assert.status", config: { in: [200] } }],
				postRequestScript: "pm.test('ok', () => {})",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not both/);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	/**
	 * A stored request whose `elements` hold both scripts plus an element this
	 * tool surface cannot address - the case a naive "write a fresh one-element
	 * array" translation silently destroys.
	 */
	function storedWithElements() {
		return {
			id: "req_1",
			name: "Get users",
			elements: [
				{ id: "el_pre", kind: "script.pre", enabled: true, config: { script: "pre();" } },
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{
					id: "el_post",
					kind: "script.post",
					enabled: true,
					config: { script: "post();" },
				},
			],
		};
	}

	test("update_request patches one script and keeps the other stored", async () => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue(storedWithElements()),
		});
		const post = "pm.test('created', () => pm.response.to.have.status(201));";
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", postRequestScript: post },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// `PUT /requests/:id` replaces `elements` wholesale, so adding a script
		// without a fetch would drop the request's other stored elements.
		expect(client.getRequest).toHaveBeenCalledWith("req_1", undefined);
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		/*
		 * `PUT /requests/:id` replaces the whole `elements` list, so the write has
		 * to carry back everything it did not mean to change: the untouched
		 * pre-request script, the assertion element MCP has no argument for
		 * (#1517), and the post script under its *existing* id. Absent keeps - a
		 * `preRequestScript: ""` filler would blank a signing script the caller
		 * never mentioned. Also proves a script alone satisfies the empty-patch
		 * refusal, which counts the payload's keys.
		 */
		expect(payload).toEqual({
			elements: [
				{ id: "el_pre", kind: "script.pre", enabled: true, config: { script: "pre();" } },
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{ id: "el_post", kind: "script.post", enabled: true, config: { script: post } },
			],
		});
	});

	test("update_request clears a script when passed an empty string", async () => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue(storedWithElements()),
		});
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", preRequestScript: "" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		// `""` is a value the merge-patch honours, not an omission - the
		// difference between "leave my script alone" and "delete it".
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		// `""` is a value, not an omission - the difference between "leave my
		// script alone" and "delete it". Clearing drops the element outright
		// rather than leaving an enabled one whose script runs nothing, and takes
		// nothing else with it.
		expect(payload).toEqual({
			elements: [
				{ id: "el_x", kind: "assert.status", enabled: true, config: { equals: 200 } },
				{
					id: "el_post",
					kind: "script.post",
					enabled: true,
					config: { script: "post();" },
				},
			],
		});
	});

	test("update_request sending `elements` directly needs no fetch", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", elements: [{ kind: "assert.status", config: { in: [200] } }] },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRequest).not.toHaveBeenCalled();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({
			elements: [{ kind: "assert.status", config: { in: [200] } }],
		});
	});

	test("update_request refuses both `elements` and script sugar on the same call", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_1",
				elements: [{ kind: "assert.status", config: { in: [200] } }],
				preRequestScript: "pm.request.headers.add('x-run', '1')",
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not both/);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request reads nothing when no script is named", async () => {
		// The read-merge-write is the script path's alone: a rename must not pay
		// for a GET, and #1436's merge-patch rule still governs every other field.
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", name: "Renamed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.getRequest).not.toHaveBeenCalled();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ name: "Renamed" });
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

	test("update_request refuses fixed mode with no example id", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockResponseMode: "fixed" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/mockResponseMode/);
		expect(firstText(res)).toMatch(/mockExampleId/);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("update_request forwards a mock response mode that needs no example", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockResponseMode: "random" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ mockResponseMode: "random" });
	});

	test("update_request clears mockExampleId with an explicit null, distinct from omitting it", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", mockExampleId: null },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload).toEqual({ mockExampleId: null });
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

	/**
	 * With Reveal secrets to agents off, an agent may not turn a stored secret
	 * into a readable one by writing `secret: false` (#1809). The three tools that
	 * merge variables share one gate, so each is driven through the same cases.
	 */
	describe("clearing a stored secret flag (#1809)", () => {
		const stored = { token: { value: "t0k", enabled: true, secret: true, type: "string" } };
		const cases = [
			{
				tool: "update_environment",
				args: { environmentId: "env_1" },
				seed: () => ({
					getEnvironment: vi
						.fn()
						.mockResolvedValue({ id: "env_1", name: "Dev", variables: stored }),
				}),
				write: (c: EngineClient) => c.updateEnvironment,
				sent: (call: unknown[]) => varsOf(call[1]),
			},
			{
				tool: "update_globals",
				args: {},
				seed: () => ({ getGlobals: vi.fn().mockResolvedValue({ variables: stored }) }),
				write: (c: EngineClient) => c.saveGlobals,
				sent: (call: unknown[]) => varsOf(call[0]),
			},
			{
				tool: "update_collection",
				args: { collectionId: "col_1" },
				seed: () => ({
					getCollection: vi
						.fn()
						.mockResolvedValue({ id: "col_1", name: "API", variables: stored }),
				}),
				write: (c: EngineClient) => c.updateCollection,
				sent: (call: unknown[]) => varsOf(call[1]),
			},
		];

		describe.each(cases)("$tool", ({ tool, args, seed, write, sent }) => {
			const run = (variables: Record<string, unknown>, safety: Partial<McpSafetyConfig>) => {
				const client = fakeClient(seed());
				return dispatchTool(tool, { ...args, variables }, ctxWith(client, safety)).then(
					(res) => ({ res, client })
				);
			};

			test("refuses secret:false over a stored secret, naming the setting", async () => {
				const { res, client } = await run({ token: { secret: false } }, WRITES);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain("token");
				expect(firstText(res)).toContain("Reveal secrets to agents");
				expect(firstText(res)).toContain("Vayu Settings → MCP");
				expect(write(client)).not.toHaveBeenCalled();
			});

			test("refuses it when a value rides along, too", async () => {
				const { res, client } = await run(
					{ token: { value: "new", secret: false } },
					WRITES
				);
				expect(res.isError).toBe(true);
				expect(write(client)).not.toHaveBeenCalled();
			});

			test("allows it once reveal is on", async () => {
				const { res, client } = await run(
					{ token: { secret: false } },
					{ ...WRITES, revealSecretsToAgents: true }
				);
				expect(res.isError).toBeFalsy();
				expect(sent(lastCall(write(client))).token).toMatchObject({ secret: false });
			});

			test("leaves secret:true and unrelated edits alone with reveal off", async () => {
				const keep = await run({ token: { secret: true, enabled: false } }, WRITES);
				expect(keep.res.isError).toBeFalsy();
				expect(sent(lastCall(write(keep.client))).token).toMatchObject({
					secret: true,
					enabled: false,
				});

				const rotate = await run({ token: "rotated" }, WRITES);
				expect(rotate.res.isError).toBeFalsy();
				expect(sent(lastCall(write(rotate.client))).token).toMatchObject({
					value: "rotated",
					secret: true,
				});

				const fresh = await run({ other: { value: "o", secret: false } }, WRITES);
				expect(fresh.res.isError).toBeFalsy();
				expect(sent(lastCall(write(fresh.client))).other).toMatchObject({ secret: false });
			});
		});
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
		expect(client.getCookiesPage).toHaveBeenCalled();
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

	/** A context whose client answered the confirmation question with `outcome`. */
	function ctxAnswered(
		client: EngineClient,
		outcome: { action: string; content?: Record<string, unknown> }
	): ToolContext {
		return ctxAsking(client, { allowWrites: true }, { confirm: outcome });
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

	test("delete_collection asks the person, and deletes nothing while it asks", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxAsking(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.deleteCollection).not.toHaveBeenCalled();
		// The person answering sees the counts, not just an id.
		const question = askedQuestion(res);
		expect(question).toContain("2 sub-collection(s)");
		expect(question).toContain("3 saved request(s)");
	});

	test("delete_collection takes the person's answer as the confirmation", async () => {
		const client = treeClient();
		const ctx = ctxAnswered(client, { action: "accept", content: { proceed: true } });
		// No `confirmed` flag - the human answered the question instead.
		const res = await dispatchTool("delete_collection", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(INPUT_REQUIRED.has(res)).toBe(false);
		expect(firstText(res)).not.toMatch(/awaiting confirmation/i);
		expect(client.deleteCollection).toHaveBeenCalledTimes(1);
	});

	test("a cancelled question deletes nothing", async () => {
		const client = treeClient();
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1" },
			ctxAnswered(client, { action: "cancel" })
		);
		expect(firstText(res)).toMatch(/declined/i);
		expect(INPUT_REQUIRED.has(res)).toBe(false);
		expect(client.deleteCollection).not.toHaveBeenCalled();
	});

	test("a declined prompt deletes nothing, even with the flag set", async () => {
		const client = treeClient();
		const ctx = ctxAnswered(client, { action: "accept", content: { proceed: false } });
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
					new EngineRequestError("Engine responded 404", 404, "Request not found")
				),
		});
		const res = await dispatchTool(
			"delete_request",
			{ requestId: "req_gone", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No request with id "req_gone"');
		expect(client.deleteRequest).not.toHaveBeenCalled();
	});
});

/**
 * The Trash tools (issue #1071): list what `delete_collection` / `delete_request`
 * left recoverable, restore from it, or purge it for good. `restore_trash_entry`
 * is the one write here that is not destructive - it puts a row back rather than
 * removing one - so it carries the write toggle alone; `purge_trash_entry` is the
 * Trash's own hard delete and carries both gates the way `delete_collection` does.
 */
describe("trash tools", () => {
	const TRASH_ITEM = {
		id: "col_9",
		kind: "collection",
		name: "Retired API",
		deletedAt: 1_755_000_000_000,
		parentId: null,
		collections: 2,
		requests: 5,
	};

	test("list_trash answers one page of entries, each as the engine wrote it", async () => {
		const client = fakeClient({ listTrashPage: vi.fn().mockResolvedValue(page([TRASH_ITEM])) });
		const res = await dispatchTool("list_trash", { q: "retired" }, ctxWith(client));
		expect(res.isError).toBeFalsy();
		expect(JSON.parse(firstText(res))).toEqual(lastPageAnswer(page([TRASH_ITEM])));
		expect(client.listTrashPage).toHaveBeenCalledWith(
			{ q: "retired", limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
		// The unpaged read stays the purge prompt's, not the list's.
		expect(client.listTrash).not.toHaveBeenCalled();
	});

	test("restore_trash_entry restores and reports a re-parented collection", async () => {
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockResolvedValue({ ...TRASH_ITEM, restored: true, reparentedToRoot: true }),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ id: "col_9" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.restoreTrashEntry).toHaveBeenCalledWith("col_9", undefined);
		// The caveat is what tells the caller its parent did not survive - without
		// it the result reads as an ordinary restore to where it was.
		expect(res.content.map((c) => c.text).join("\n")).toMatch(/top level/i);
	});

	test("restore_trash_entry surfaces the engine's own 409 message verbatim", async () => {
		// The engine's actual wording, in the shape `error_response` actually
		// sends it: nested `{"error": {"code", "message"}}` per routes.hpp, which
		// is the one shape issue #173 settled on. A flat `{"error": "..."}`
		// fixture here would have passed against a body the trash routes never
		// produce, and the agent would have been shown raw JSON.
		const message =
			"Request 'req_5' cannot be restored on its own - the collection it belongs to is in the trash, so restore that first";
		const client = fakeClient({
			restoreTrashEntry: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 409",
						409,
						JSON.stringify({ error: { code: "conflict", message } })
					)
				),
		});
		const res = await dispatchTool(
			"restore_trash_entry",
			{ id: "req_5" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		// Verbatim - not a paraphrase this tool invented and could disagree with.
		expect(firstText(res)).toBe(message);
	});

	test("restore_trash_entry refuses while writes are disabled, without calling the engine", async () => {
		const client = fakeClient();
		const res = await dispatchTool("restore_trash_entry", { id: "col_9" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(client.restoreTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry previews the entry's name and counts, and purges nothing", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [TRASH_ITEM], total: 1 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ id: "col_9" },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(firstText(res)).toMatch(/awaiting confirmation/i);
		expect(firstText(res)).toContain("Retired API");
		expect(firstText(res)).toContain("2 sub-collection(s)");
		expect(firstText(res)).toContain("5 saved request(s)");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry purges once confirmed", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [TRASH_ITEM], total: 1 }),
			purgeTrashEntry: vi.fn().mockResolvedValue({ ...TRASH_ITEM, purged: true }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ id: "col_9", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(client.purgeTrashEntry).toHaveBeenCalledWith("col_9", undefined);
	});

	test("purge_trash_entry refuses an id the trash does not hold, without a prompt", async () => {
		const client = fakeClient({
			listTrash: vi.fn().mockResolvedValue({ items: [], total: 0 }),
		});
		const res = await dispatchTool(
			"purge_trash_entry",
			{ id: "col_missing", confirmed: true },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("col_missing");
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
	});

	test("purge_trash_entry refuses while writes are disabled, without reading the trash", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"purge_trash_entry",
			{ id: "col_9", confirmed: true },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(client.listTrash).not.toHaveBeenCalled();
		expect(client.purgeTrashEntry).not.toHaveBeenCalled();
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
		return found!.inputSchema[field] as z.ZodType;
	}

	describe("saved-request auth and settings", () => {
		const auth = { mode: "bearer", token: "{{apiToken}}" };

		test("create_request stores auth and the five Settings fields", async () => {
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
					timeout: 1500,
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
				timeout: 1500,
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
				"timeout",
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
			["timeout", 1500],
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

		test("update_request sends an explicit null to reset the timeout, and refuses a value outside 1-86400000", async () => {
			// `null` is the reset (issue #2937): the engine reads an absent key as
			// "keep", so the argument has to reach the payload as `null`, not drop out.
			const client = fakeClient();
			await dispatchTool(
				"update_request",
				{ requestId: "req_1", timeout: null },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.updateRequest)[1]).toEqual({ timeout: null });

			const schema = schemaOf("update_request", "timeout");
			for (const refused of [0, -5, 86_400_001, 1.5, "30s"]) {
				expect(schema.safeParse(refused).success, String(refused)).toBe(false);
			}
			for (const accepted of [1, 86_400_000, null, undefined]) {
				expect(schema.safeParse(accepted).success, String(accepted)).toBe(true);
			}
			expect(schemaOf("create_request", "timeout").safeParse(null).success).toBe(true);
		});

		test("run_request refuses a per-call downgrade before anything is sent", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: false },
				ctxWith(client, allow)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(resolveRemedyTokens(INSECURE_TLS_REFUSAL, "app"));
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
		test("create_collection stores variables, auth and both scripts as elements", async () => {
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
			// Both scripts leave as `elements` (issue #1514); the engine refuses
			// the per-phase keys outright, and assigns each entry its own `el_` id.
			expect(callArgs(client.createCollection)[0]).toEqual({
				name: "API",
				auth: { mode: "apikey", key: "X-Key", value: "{{token}}" },
				elements: [
					{
						kind: "script.pre",
						enabled: true,
						config: { script: "pm.request.headers.add('x-run', '1')" },
					},
					{
						kind: "script.post",
						enabled: true,
						config: { script: "pm.test('ok', () => {})" },
					},
				],
				variables: {
					baseUrl: { enabled: true, value: "https://api.example.com" },
					token: { enabled: true, value: "t", secret: true },
				},
			});
		});

		test("create_collection refuses both `elements` and script sugar on the same call", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"create_collection",
				{
					name: "API",
					elements: [{ kind: "assert.status", config: { in: [200] } }],
					preRequestScript: "pm.request.headers.add('x-run', '1')",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.createCollection).not.toHaveBeenCalled();
		});

		test("update_collection upserts a script into the stored elements list", async () => {
			const client = fakeClient({
				getCollection: vi.fn().mockResolvedValue({
					id: "col_1",
					name: "API",
					elements: [
						{
							id: "el_a",
							kind: "script.pre",
							enabled: true,
							config: { script: "chain();" },
						},
						{
							id: "el_b",
							kind: "script.post",
							enabled: true,
							config: { script: "old();" },
						},
					],
				}),
			});
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", postRequestScript: "fresh();" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// A collection's scripts run for every request below it, so dropping a
			// sibling element on a one-script edit would change what a whole tree
			// does. The stored list is read and merged, never overwritten.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				elements: [
					{
						id: "el_a",
						kind: "script.pre",
						enabled: true,
						config: { script: "chain();" },
					},
					{
						id: "el_b",
						kind: "script.post",
						enabled: true,
						config: { script: "fresh();" },
					},
				],
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

		test("a plain rename needs no read, and an empty patch is refused", async () => {
			const client = fakeClient();
			const renamed = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", name: "Renamed" },
				ctxWith(client, { allowWrites: true })
			);
			expect(renamed.isError).toBeFalsy();
			// Only variables and scripts are read-merge-writes; a rename is not.
			expect(client.getCollection).not.toHaveBeenCalled();
			expect(callArgs(client.updateCollection)[1]).toEqual({ name: "Renamed" });

			const nothing = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(nothing.isError).toBe(true);
			expect(client.updateCollection).toHaveBeenCalledTimes(1);
		});

		test("an empty collection script clears its element, and still satisfies the patch check", async () => {
			const client = fakeClient({
				getCollection: vi.fn().mockResolvedValue({
					id: "col_1",
					name: "API",
					elements: [
						{
							id: "el_a",
							kind: "script.pre",
							enabled: true,
							config: { script: "chain();" },
						},
						{
							id: "el_b",
							kind: "script.post",
							enabled: true,
							config: { script: "keep();" },
						},
					],
				}),
			});
			const res = await dispatchTool(
				"update_collection",
				{ collectionId: "col_1", preRequestScript: "" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			// An empty string is still a value - how a collection script is cleared -
			// but clearing is now a removal from `elements`, so it costs the read the
			// merge needs, and a script alone still passes the empty-patch refusal.
			expect(client.getCollection).toHaveBeenCalledWith("col_1", undefined);
			expect(callArgs(client.updateCollection)[1]).toEqual({
				elements: [
					{
						id: "el_b",
						kind: "script.post",
						enabled: true,
						config: { script: "keep();" },
					},
				],
			});
		});

		test("update_collection refuses both `elements` and script sugar on the same call", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"update_collection",
				{
					collectionId: "col_1",
					elements: [{ kind: "assert.status", config: { in: [200] } }],
					postRequestScript: "pm.test('ok', () => {})",
				},
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.updateCollection).not.toHaveBeenCalled();
		});
	});

	describe("move_item", () => {
		/**
		 * Two collections at the root and three under `col_1`. A parent's
		 * sub-collections and requests share one `order` space (#2535), so the
		 * request lists below interleave with these folders' slots.
		 */
		const TREE = [
			{ id: "col_1", name: "API", parentId: "", order: 0, createdAt: 1_700_000_000_000 },
			{ id: "col_2", name: "Internal", parentId: "", order: 1, createdAt: 1_700_000_001_000 },
			{ id: "col_1a", name: "v1", parentId: "col_1", order: 0, createdAt: 1_700_000_002_000 },
			{ id: "col_1b", name: "v2", parentId: "col_1", order: 2, createdAt: 1_700_000_003_000 },
			{
				id: "col_2a",
				name: "Admin",
				parentId: "col_2",
				order: 0,
				createdAt: 1_700_000_004_000,
			},
			{
				id: "col_2b",
				name: "Ops",
				parentId: "col_2",
				order: 1,
				createdAt: 1_700_000_005_000,
			},
		];

		function moveClient(requests: Record<string, unknown[]> = {}) {
			return fakeClient({
				listCollections: vi.fn().mockResolvedValue(TREE),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) => Promise.resolve(requests[id] ?? [])),
			});
		}

		const at = (id: string, order: number, createdAt = 1_700_000_100_000) => ({
			id,
			order,
			createdAt,
		});

		test("a request moved into a folder-only collection lands past its folders, not between them", async () => {
			// `col_2` holds folders at 0 and 1 and no requests. Counting requests
			// alone would answer slot 0, which sorts between the two folders.
			const client = moveClient();
			const res = await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "request", id: "req_1", order: 2, collectionId: "col_2" }],
			});
		});

		test("a request lands after the folders and requests of an interleaved parent", async () => {
			// `col_1`: v1 at 0, r_mid at 1, v2 at 2 - already dense, so only the
			// moved row is written.
			const client = moveClient({ col_1: [at("r_mid", 1)] });
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "request", id: "req_1", order: 3, collectionId: "col_1" }],
			});
		});

		test("a folder moved into a parent lands after its last request", async () => {
			// `col_2` gains a request at 2, past both its folders; a folder moved in
			// last belongs at 3. Counting folders alone would answer 2, which ties
			// the request and sorts ahead of it on the kind rank.
			const client = moveClient({ col_2: [at("r_tail", 2)] });
			await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_1a", parentId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [{ type: "collection", id: "col_1a", order: 3, parentId: "col_2" }],
			});
			expect(client.listRequests).toHaveBeenCalledWith("col_2", undefined);
		});

		test("position 'first' shifts the siblings of both kinds, each under its own type", async () => {
			const client = moveClient({ col_1: [at("r_mid", 1)] });
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_1", position: "first" },
				ctxWith(client, { allowWrites: true })
			);
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 0, collectionId: "col_1" },
					{ type: "collection", id: "col_1a", order: 1 },
					{ type: "request", id: "r_mid", order: 2 },
					{ type: "collection", id: "col_1b", order: 3 },
				],
			});
		});

		test("position 'first' leaves a sibling alone when its slot is already right", async () => {
			const client = moveClient({ col_1: [at("r_mid", 2)] });
			await dispatchTool(
				"move_item",
				{ type: "collection", id: "col_2a", parentId: "col_1", position: "first" },
				ctxWith(client, { allowWrites: true })
			);
			// v1 0 -> 1. v2 already sits at 2, its slot after the insert, so it is
			// not written; r_mid ties it at 2, sorts after it on the kind rank, and
			// goes to 3.
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "collection", id: "col_2a", order: 0, parentId: "col_1" },
					{ type: "collection", id: "col_1a", order: 1 },
					{ type: "request", id: "r_mid", order: 3 },
				],
			});
		});

		test("repositioning inside the same collection does not leave the row tied", async () => {
			// The bug this shape exists to prevent: state the whole arrangement,
			// and the moved row cannot land level with the sibling it displaced.
			const client = moveClient({ col_1: [at("req_1", 1), at("r2", 3)] });
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_1" },
				ctxWith(client, { allowWrites: true })
			);
			const batch = callArgs(client.reorder)[0] as { moves: Array<Record<string, unknown>> };
			// Left without it: v1 0, v2 2, r2 3 -> v2 to 1 and r2 to 2, req_1 last.
			expect(batch.moves).toEqual([
				{ type: "request", id: "req_1", order: 3, collectionId: "col_1" },
				{ type: "collection", id: "col_1b", order: 1 },
				{ type: "request", id: "r2", order: 2 },
			]);
			const orders = batch.moves.map((m) => m.order);
			expect(new Set(orders).size).toBe(orders.length);
		});

		test("rows tied across kinds get distinct positions, the folder first", async () => {
			// Admin and both requests at 0, as rows that predate explicit orders read.
			const client = moveClient({
				col_2: [at("r1", 0, 1_700_000_200_000), at("r2", 0, 1_700_000_100_000)],
			});
			await dispatchTool(
				"move_item",
				{ type: "request", id: "req_1", collectionId: "col_2" },
				ctxWith(client, { allowWrites: true })
			);
			// The tie at 0 ranks Admin first and the requests by createdAt (r2, r1),
			// which pushes Ops from 1 to 3.
			expect(callArgs(client.reorder)[0]).toEqual({
				moves: [
					{ type: "request", id: "req_1", order: 4, collectionId: "col_2" },
					{ type: "request", id: "r2", order: 1 },
					{ type: "request", id: "r1", order: 2 },
					{ type: "collection", id: "col_2b", order: 3 },
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
			// The top level holds collections only; there is no request list to read.
			expect(client.listRequests).not.toHaveBeenCalled();
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

	test("skips a request whose host is left as {{baseUrl}} with the gate's remedy as its reason (#2450)", async () => {
		const client = fakeClient({
			listRequests: vi
				.fn()
				.mockResolvedValue([
					{ id: "r1", name: "one", method: "GET", url: "{{baseUrl}}/x" },
				]),
			composeRequest: vi.fn().mockResolvedValue({ method: "GET", url: "{{baseUrl}}/x" }),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const matrix = res.structuredContent as {
			skipped: number;
			results: Array<{ reason?: string }>;
		};
		expect(matrix.skipped).toBe(1);
		const reason = matrix.results[0].reason ?? "";
		expect(reason).toMatch(/^Could not determine the target host/);
		expect(reason).toContain("{{baseUrl}}");
		expect(reason).toContain("update_collection");
		expect(client.executeRequest).not.toHaveBeenCalled();
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
			listEnvironments: listingEnv1(),
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
		// Executed exactly as composed - resolved once, never re-resolved - with
		// only the run's origin and the session's target policy added beside it.
		const outgoing = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(outgoing).toEqual({
			...composed,
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
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
		// Both ways out are named: the smoke option, and the stored run.
		expect(text).toContain("`recursive: true` to run the whole tree in this tool");
		expect(text).toMatch(/`run_collection` with `recursive: true`/);
		// The matrix itself is untouched: it counts the direct requests it ran.
		expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
		// Direct-only rows name no folder.
		expect(
			(res.structuredContent as { results: Array<{ folder?: string }> }).results[0].folder
		).toBeUndefined();
	});

	test("names the recursive paths when the collection list could not be read", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "ok" }]),
			listCollections: vi
				.fn()
				.mockRejectedValueOnce(new Error("engine hiccup"))
				// The masking read after the sends asks for the list again.
				.mockResolvedValue([]),
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
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toContain("could not read the collection list");
		expect(text).toMatch(/`run_collection` with `recursive: true`/);
	});

	describe("recursive", () => {
		/**
		 * Root `c1` ("API") files, in sibling order: folder Users (order 0), its
		 * own request (order 1), folder Billing (order 2) - the shape an OpenAPI
		 * import gives, plus a direct request between two subtrees.
		 */
		function treeClient(overrides: Parameters<typeof fakeClient>[0] = {}) {
			const requestsByCollection: Record<string, object[]> = {
				c1: [{ id: "r_direct", name: "direct", order: 1 }],
				c2: [{ id: "r_user", name: "user", order: 0 }],
				c3: [
					{ id: "r_invoice", name: "invoice", order: 0 },
					{ id: "r_refund", name: "refund", order: 1 },
				],
			};
			return fakeClient({
				listCollections: vi.fn().mockResolvedValue([
					{ id: "c1", name: "API" },
					{ id: "c3", name: "Billing", parentId: "c1", order: 2 },
					{ id: "c2", name: "Users", parentId: "c1", order: 0 },
					{ id: "c9", name: "Elsewhere" },
				]),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) =>
						Promise.resolve(requestsByCollection[id] ?? [])
					),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
				...overrides,
			});
		}

		test("runs the whole tree in the sidebar's order and names each row's folder", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const summary = res.structuredContent as {
				total: number;
				passed: number;
				results: Array<{ name: string; folder?: string }>;
			};
			// Non-empty on purpose: a walk that found nothing would also be "in order".
			expect(summary.total).toBe(4);
			expect(summary.passed).toBe(4);
			expect(summary.results.map((row) => [row.name, row.folder])).toEqual([
				["user", "API / Users"],
				["direct", "API"],
				["invoice", "API / Billing"],
				["refund", "API / Billing"],
			]);
			expect(
				(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls.map(
					(call) => (call[0] as { requestId: string }).requestId
				)
			).toEqual(["r_user", "r_direct", "r_invoice", "r_refund"]);
			// The SDK client checks structuredContent against the advertised JSON
			// schema, where an undeclared row field is refused; zod's own parse
			// strips it silently, so compare the keys against the emitted schema.
			const advertised = z.toJSONSchema(
				TOOLS.find((t) => t.name === "run_collection_smoke")!.outputSchema!,
				{ io: "output" }
			) as unknown as {
				properties: { results: { items: { properties: Record<string, unknown> } } };
			};
			const declared = Object.keys(advertised.properties.results.items.properties);
			expect(declared).toContain("folder");
			for (const row of summary.results) {
				expect(declared).toEqual(expect.arrayContaining(Object.keys(row)));
			}
			// A collection outside the subtree is never read, and the run left
			// nothing out, so it carries no scope caveat.
			expect(client.listRequests).not.toHaveBeenCalledWith("c9", undefined);
			expect(res.content.map((c) => c.text).join("\n")).not.toContain("NOT run");
		});

		test("without recursive the same tree runs the direct request alone", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1" },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.structuredContent).toMatchObject({ total: 1, passed: 1 });
			expect(res.content.map((c) => c.text).join("\n")).toContain(
				"2 sub-collection(s) were NOT run"
			);
		});

		test("a page slices the expanded list, not the direct requests", async () => {
			const client = treeClient();
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true, limit: 2, offset: 1 },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			const summary = res.structuredContent as {
				results: Array<{ name: string; folder?: string }>;
			};
			// Expanded order is user, direct, invoice, refund: offset 1 starts at "direct".
			expect(summary.results.map((row) => [row.name, row.folder])).toEqual([
				["direct", "API"],
				["invoice", "API / Billing"],
			]);
			expect(res.structuredContent).toMatchObject({
				total: 2,
				requestTotal: 4,
				hasMore: true,
				next: { offset: 3 },
			});
			// Only the page was composed; the rest of the list was read, not run.
			expect(client.composeRequest).toHaveBeenCalledTimes(2);
		});

		test("a parent cycle terminates and runs each request once", async () => {
			const client = treeClient({
				listCollections: vi.fn().mockResolvedValue([
					{ id: "c1", name: "A", parentId: "c2" },
					{ id: "c2", name: "B", parentId: "c1" },
				]),
				listRequests: vi
					.fn()
					.mockImplementation((id: string) =>
						Promise.resolve([{ id: `r_${id}`, name: `req ${id}` }])
					),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ total: 2, passed: 2 });
		});

		test("a collection list that cannot be read is the engine error, and nothing is sent", async () => {
			const client = treeClient({
				listCollections: vi
					.fn()
					.mockRejectedValue(new EngineRequestError("Engine responded 500", 500, "boom")),
			});
			const res = await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", recursive: true },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		});
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

	test("a failing inherited assertion names its level, ahead of the script it ran in", async () => {
		// Issue #2522: a collection's or a folder's assertion failed this request,
		// and the request's own script is the wrong place to go looking for it.
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "inherits" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/ok" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 200,
				testResults: [
					{ name: "root check", passed: false, source: "test", scope: "collection" },
					{ name: "folder setup", passed: false, source: "pre", scope: "folder" },
					{ name: "own check", passed: false, source: "test", scope: "request" },
					{ name: "stored before", passed: false, source: "test" },
					{ name: "unheard of", passed: false, source: "test", scope: "toString" },
				],
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const summary = res.structuredContent as {
			results: Array<{ tests?: { failures?: string[] } }>;
		};

		expect(summary.results[0].tests?.failures).toEqual([
			"[collection] root check",
			"[folder] [pre-request] folder setup",
			"own check",
			"stored before",
			"unheard of",
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
		// Revealed, because with secrets withheld the same failed read leaves the
		// matrix unmaskable and the call fails closed (`secret withholding`).
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
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
		expect(descriptionOf(tool)).toMatch(/DIRECT requests/);
		expect(descriptionOf(tool)).toMatch(/one at a time/);
	});

	test("the tool description steers a large collection to run_collection and says it reports progress", () => {
		const text = descriptionOf(TOOLS.find((t) => t.name === "run_collection_smoke"));
		expect(text).toMatch(/past about 25 requests or on a slow API use run_collection/);
		expect(text).toMatch(/get_run_report/);
		expect(text).toMatch(/Reports progress when the client asks/);
	});

	/**
	 * A long smoke run was silent until it finished (#2451). The client hears
	 * of it through `ctx.progress`, which exists only when it sent a
	 * `progressToken`; every row ticks it exactly once, however the row ended.
	 */
	describe("progress", () => {
		const SECRET = "s3cr3t-token-value";

		/** Five rows, one per way a row can end; each carries SECRET wherever a row could echo it. */
		function mixedRows() {
			const rows = ["ok", "compose", "offlist", "status", "send"].map((kind, i) => ({
				id: `r${i + 1}`,
				name: `${kind} ${SECRET}`,
				method: "GET",
				url: `https://${kind === "offlist" ? "evil.test" : "api.example.com"}/${kind}?k=${SECRET}`,
			}));
			const byId = new Map(rows.map((r) => [r.id, r]));
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi
					.fn()
					.mockImplementation(({ requestId }: { requestId: string }) => {
						if (requestId === "r2") {
							return Promise.reject(new Error(`compose failed for ${SECRET}`));
						}
						const row = byId.get(requestId)!;
						return Promise.resolve({ method: row.method, url: row.url, requestId });
					}),
				executeRequest: vi
					.fn()
					.mockImplementation(({ requestId }: { requestId: string }) => {
						if (requestId === "r5")
							return Promise.reject(new Error(`send failed ${SECRET}`));
						return Promise.resolve({
							status: requestId === "r4" ? 500 : 200,
							testResults: [],
						});
					}),
			});
		}

		const smoke = (ctx: ToolContext) =>
			dispatchTool("run_collection_smoke", { collectionId: "c1" }, ctx);
		const onApi = { allowlist: ["api.example.com"] };

		test("ticks 0/total, then once per row, for a collection that all passes", async () => {
			const rows = [1, 2, 3, 4, 5].map((n) => ({
				id: `r${n}`,
				name: `n${n}`,
				method: "GET",
				url: `https://api.example.com/${n}`,
			}));
			const client = fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({
						method: "GET",
						url: `https://api.example.com/${requestId}`,
					})
				),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
			});
			const progress = vi.fn();
			const res = await smoke({ ...ctxWith(client, onApi), progress });
			expect(res.structuredContent).toMatchObject({ total: 5, passed: 5 });
			expect(progress.mock.calls).toEqual([
				[0, 5],
				[1, 5, "1/5 ok"],
				[2, 5, "2/5 ok"],
				[3, 5, "3/5 ok"],
				[4, 5, "4/5 ok"],
				[5, 5, "5/5 ok"],
			]);
		});

		test("a skipped row, a compose failure, a bad status and a send error each still tick", async () => {
			const progress = vi.fn();
			const res = await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			expect(res.structuredContent).toMatchObject({
				total: 5,
				passed: 1,
				failed: 3,
				skipped: 1,
			});
			expect(progress.mock.calls).toEqual([
				[0, 5],
				[1, 5, "1/5 ok"],
				[2, 5, "2/5 failed"],
				[3, 5, "3/5 skipped"],
				[4, 5, "4/5 failed"],
				[5, 5, "5/5 failed"],
			]);
		});

		test("a message is an index and a status word, never a name, url or error text", async () => {
			const progress = vi.fn();
			await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			const messages = progress.mock.calls.map(([, , message]) => message).filter(Boolean);
			// Non-empty, so the loop below cannot pass by reading nothing.
			expect(messages).toHaveLength(5);
			for (const message of messages) {
				expect(message).toMatch(/^\d+\/5 (ok|skipped|failed)$/);
				expect(message).not.toContain(SECRET);
			}
		});

		test("an empty collection ticks nothing", async () => {
			const progress = vi.fn();
			const client = fakeClient({ listRequests: vi.fn().mockResolvedValue([]) });
			await smoke({ ...ctxWith(client, onApi), progress });
			expect(progress).not.toHaveBeenCalled();
		});

		test("without ctx.progress the result is the same", async () => {
			const progress = vi.fn();
			const plain = await smoke(ctxWith(mixedRows(), onApi));
			const ticked = await smoke({ ...ctxWith(mixedRows(), onApi), progress });
			expect(progress).toHaveBeenCalled();
			expect(plain.isError).toBeFalsy();
			expect(plain.structuredContent).toEqual(ticked.structuredContent);
		});
	});
	/**
	 * A call runs one bounded page of the collection and says in the result what
	 * it left (#2451). `total` and the counts stay the rows run in this call;
	 * `requestTotal` is the collection's size in scope.
	 */
	describe("paging", () => {
		const onApi = { allowlist: ["api.example.com"] };

		/** `count` saved requests, named "req N", each composing to its own passing URL. */
		function pagedClient(count: number, overrides: Parameters<typeof fakeClient>[0] = {}) {
			const rows = Array.from({ length: count }, (_, i) => ({
				id: `r${i + 1}`,
				name: `req ${i + 1}`,
				method: "GET",
				url: `https://api.example.com/${i + 1}`,
			}));
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue(rows),
				composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
					Promise.resolve({
						method: "GET",
						url: `https://api.example.com/${requestId}`,
					})
				),
				executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
				...overrides,
			});
		}

		interface Paged {
			total: number;
			passed: number;
			requestTotal: number;
			hasMore: boolean;
			next?: { offset: number };
			cancelled?: boolean;
			note?: string;
			results: Array<{ name: string }>;
		}

		const smokePage = (
			client: EngineClient,
			args: Record<string, unknown>,
			signal?: AbortSignal
		) =>
			dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", ...args },
				ctxWith(client, onApi),
				signal
			);
		const pagedOf = (res: ToolResult) => res.structuredContent as unknown as Paged;
		const namesOf = (res: ToolResult) => pagedOf(res).results.map((row) => row.name);

		test("limit and offset cut a window from the list and say where the next one starts", async () => {
			const client = pagedClient(5);
			const res = await smokePage(client, { limit: 2, offset: 0 });
			expect(namesOf(res)).toEqual(["req 1", "req 2"]);
			expect(pagedOf(res)).toMatchObject({
				total: 2,
				passed: 2,
				requestTotal: 5,
				hasMore: true,
				next: { offset: 2 },
			});
			expect(pagedOf(res).cancelled).toBeUndefined();
			expect(pagedOf(res).note).toContain("Ran 2 of 5 requests");
			expect(pagedOf(res).note).toContain("offset: 2");
			expect(client.executeRequest).toHaveBeenCalledTimes(2);

			const second = await smokePage(client, { limit: 2, offset: 2 });
			expect(namesOf(second)).toEqual(["req 3", "req 4"]);
			expect(pagedOf(second).next).toEqual({ offset: 4 });
		});

		test("the last page runs what is left and offers no next page", async () => {
			const res = await smokePage(pagedClient(5), { limit: 2, offset: 4 });
			expect(namesOf(res)).toEqual(["req 5"]);
			expect(pagedOf(res)).toMatchObject({ total: 1, requestTotal: 5, hasMore: false });
			expect(pagedOf(res)).not.toHaveProperty("next");
			expect(pagedOf(res)).not.toHaveProperty("note");
		});

		test.each([5, 99])(
			"an offset of %i past a 5-request list runs nothing and says so",
			async (offset) => {
				const client = pagedClient(5);
				const res = await smokePage(client, { offset });
				expect(res.isError).toBeFalsy();
				expect(pagedOf(res)).toMatchObject({
					total: 0,
					requestTotal: 5,
					hasMore: false,
					results: [],
				});
				expect(pagedOf(res)).not.toHaveProperty("next");
				expect(pagedOf(res).note).toMatch(/past the end/);
				expect(client.composeRequest).not.toHaveBeenCalled();
			}
		);

		test("a collection that fits one page carries the size and no note", async () => {
			const res = await smokePage(pagedClient(3), {});
			expect(pagedOf(res)).toMatchObject({ total: 3, requestTotal: 3, hasMore: false });
			expect(pagedOf(res)).not.toHaveProperty("note");
		});

		test("the default limit of 25 cuts a longer list and discloses the rest in the result", async () => {
			const client = pagedClient(30);
			const first = await smokePage(client, {});
			expect(pagedOf(first).results).toHaveLength(25);
			expect(pagedOf(first)).toMatchObject({
				total: 25,
				requestTotal: 30,
				hasMore: true,
				next: { offset: 25 },
			});
			expect(pagedOf(first).note).toContain("Ran 25 of 30 requests");
			// The note is in the text block a client reads, not only the structured one.
			expect(firstText(first)).toContain("call again with offset: 25");

			const rest = await smokePage(client, { offset: 25 });
			expect(namesOf(rest)).toEqual(["req 26", "req 27", "req 28", "req 29", "req 30"]);
			expect(pagedOf(rest).hasMore).toBe(false);
		});

		test.each([
			["limit above 100", { limit: 101 }],
			["limit of 0", { limit: 0 }],
			["fractional limit", { limit: 1.5 }],
			["negative offset", { offset: -1 }],
		])("%s is refused before any request is composed or sent", async (_label, args) => {
			const client = pagedClient(5);
			const res = await smokePage(client, args);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("the advertised input bounds limit at 100 and offset at 0", () => {
			const shape = TOOLS.find((t) => t.name === "run_collection_smoke")!.inputSchema!;
			const input = z.object(shape);
			expect(input.safeParse({ collectionId: "c1", limit: 100, offset: 0 }).success).toBe(
				true
			);
			expect(input.safeParse({ collectionId: "c1", limit: 101 }).success).toBe(false);
			expect(input.safeParse({ collectionId: "c1", offset: -1 }).success).toBe(false);
		});

		test("progress counts the page it runs, not the collection", async () => {
			const progress = vi.fn();
			await dispatchTool(
				"run_collection_smoke",
				{ collectionId: "c1", limit: 2, offset: 1 },
				{ ...ctxWith(pagedClient(5), onApi), progress }
			);
			expect(progress.mock.calls).toEqual([
				[0, 2],
				[1, 2, "1/2 ok"],
				[2, 2, "2/2 ok"],
			]);
		});

		test("a paged result validates against the advertised output schema, field for field", async () => {
			const res = await smokePage(pagedClient(5), { limit: 2 });
			const outputSchema = TOOLS.find(
				(t) => t.name === "run_collection_smoke"
			)!.outputSchema!;
			expect(() => outputSchema.parse(res.structuredContent)).not.toThrow();
			// zod's own parse strips an undeclared key; the SDK client refuses it.
			const advertised = z.toJSONSchema(outputSchema, { io: "output" }) as unknown as {
				properties: Record<string, unknown>;
			};
			const returned = Object.keys(res.structuredContent!);
			expect(returned).toEqual(
				expect.arrayContaining(["requestTotal", "hasMore", "next", "note"])
			);
			expect(Object.keys(advertised.properties)).toEqual(expect.arrayContaining(returned));
		});

		describe("cancellation", () => {
			/** An `executeRequest` that completes @p completing sends, then runs @p onNext on the next. */
			function executeUntil(completing: number, onNext: () => Promise<unknown>) {
				let calls = 0;
				return vi.fn().mockImplementation(() => {
					calls += 1;
					return calls <= completing
						? Promise.resolve({ status: 200, testResults: [] })
						: onNext();
				});
			}
			const abortError = () =>
				Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

			test("a cancellation after row 2 returns those two rows and where to resume", async () => {
				const controller = new AbortController();
				const client = pagedClient(5, {
					executeRequest: vi.fn().mockImplementation(() => {
						// The cancellation lands as the second send finishes.
						if (
							(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls
								.length === 2
						) {
							controller.abort();
						}
						return Promise.resolve({ status: 200, testResults: [] });
					}),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(res.isError).toBeFalsy();
				expect(namesOf(res)).toEqual(["req 1", "req 2"]);
				expect(pagedOf(res)).toMatchObject({
					total: 2,
					passed: 2,
					requestTotal: 5,
					cancelled: true,
					hasMore: true,
					next: { offset: 2 },
				});
				expect(pagedOf(res).note).toMatch(/^Cancelled after 2 of 5 requests/);
				expect(client.executeRequest).toHaveBeenCalledTimes(2);
			});

			test("a send the cancellation interrupts is not a row, and the resume offset points at it", async () => {
				const controller = new AbortController();
				const client = pagedClient(5, {
					executeRequest: executeUntil(2, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
				});
				const res = await smokePage(client, { offset: 1 }, controller.signal);
				expect(namesOf(res)).toEqual(["req 2", "req 3"]);
				expect(pagedOf(res)).toMatchObject({
					total: 2,
					failed: 0,
					cancelled: true,
					hasMore: true,
					next: { offset: 3 },
				});
				expect(pagedOf(res).note).toContain("may have been sent");
			});

			test("a compose the cancellation interrupts is not a failed row either", async () => {
				const controller = new AbortController();
				let composed = 0;
				const client = pagedClient(3, {
					composeRequest: vi
						.fn()
						.mockImplementation(({ requestId }: { requestId: string }) => {
							composed += 1;
							if (composed === 2) {
								controller.abort();
								return Promise.reject(abortError());
							}
							return Promise.resolve({
								method: "GET",
								url: `https://api.example.com/${requestId}`,
							});
						}),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(namesOf(res)).toEqual(["req 1"]);
				expect(pagedOf(res)).toMatchObject({
					failed: 0,
					cancelled: true,
					next: { offset: 1 },
				});
			});

			test("a send error with no cancellation stays a failed row and the run goes on", async () => {
				const controller = new AbortController();
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () =>
						Promise.reject(new Error("socket hang up"))
					),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(pagedOf(res)).toMatchObject({
					total: 3,
					passed: 1,
					failed: 2,
					hasMore: false,
				});
				expect(pagedOf(res).cancelled).toBeUndefined();
				expect(
					(res.structuredContent as { results: Array<{ error?: string }> }).results[1]
						.error
				).toBe("socket hang up");
			});

			test("a cancelled call reads its masking scopes without the aborted signal, so the rows still return", async () => {
				const controller = new AbortController();
				const refusesAborted = () => (signal?: AbortSignal) =>
					signal?.aborted ? Promise.reject(abortError()) : Promise.resolve([]);
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
					listCollections: vi.fn().mockImplementation(refusesAborted()),
					listEnvironments: vi.fn().mockImplementation(refusesAborted()),
					listAllRequests: vi.fn().mockImplementation(refusesAborted()),
					getGlobals: vi
						.fn()
						.mockImplementation((signal?: AbortSignal) =>
							signal?.aborted
								? Promise.reject(abortError())
								: Promise.resolve({ variables: [] })
						),
				});
				const res = await smokePage(client, {}, controller.signal);
				expect(res.isError).toBeFalsy();
				expect(namesOf(res)).toEqual(["req 1"]);
				expect(pagedOf(res).cancelled).toBe(true);
			});

			test("a cancelled result validates against the advertised output schema, field for field", async () => {
				const controller = new AbortController();
				const client = pagedClient(3, {
					executeRequest: executeUntil(1, () => {
						controller.abort();
						return Promise.reject(abortError());
					}),
				});
				const res = await smokePage(client, {}, controller.signal);
				const outputSchema = TOOLS.find(
					(t) => t.name === "run_collection_smoke"
				)!.outputSchema!;
				expect(() => outputSchema.parse(res.structuredContent)).not.toThrow();
				const advertised = z.toJSONSchema(outputSchema, { io: "output" }) as unknown as {
					properties: Record<string, unknown>;
				};
				const returned = Object.keys(res.structuredContent!);
				expect(returned).toContain("cancelled");
				expect(Object.keys(advertised.properties)).toEqual(
					expect.arrayContaining(returned)
				);
			});
		});
	});

	test("the description states the page size and how to page", () => {
		const text = descriptionOf(TOOLS.find((t) => t.name === "run_collection_smoke"));
		expect(text).toMatch(/25 requests a call by default \(`limit`, max 100\)/);
		expect(text).toMatch(/page with `offset`/);
		expect(text).toMatch(/edited between pages shifts the window/);
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
			listEnvironments: listingEnv1(),
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

	test("is an execute tool that invalidates runs, the cookie jar and saved-back variables", () => {
		const tool = TOOLS.find((t) => t.name === "run_collection");
		expect(tool?.category).toBe("execute");
		// Steps share the environment's jar, the way a Send does, and a step's
		// script can persist variables (#1916).
		expect(tool?.invalidates).toEqual(["run", "cookie", "variables"]);
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
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
		// The absence of `mode` is what makes this a design-mode run: a mode
		// beside the block would hand the same plan to the load executor.
		expect(payload).not.toHaveProperty("mode");
	});

	// How the file was read rides with it (#2540). Mutation check: drop
	// `dataFileCastNumbers` from `scenarioBlock` and this fails.
	test("forwards the rows' file name, hash and reading into the scenario block (#2051)", async () => {
		const client = scenarioClient();
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const res = await dispatchTool(
			"run_collection",
			{
				collectionId: "c1",
				data: rows,
				dataFileName: "users.csv",
				dataFileHash: hash,
				dataFileCastNumbers: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		// Inside the block, where the engine reads them; top level beside a
		// scenario is refused engine-side.
		expect(payload.scenario).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
		expect(payload).not.toHaveProperty("dataFileName");
		expect(payload).not.toHaveProperty("dataFileHash");
		expect(payload).not.toHaveProperty("dataFileCastNumbers");
	});

	test("the schema refuses a reading that is not a boolean, on every tool that takes one", () => {
		const schemaOf = (name: string) =>
			z.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>);
		const cases = [
			[
				"run_collection",
				(cast: unknown) => ({ collectionId: "c1", dataFileCastNumbers: cast }),
			],
			["start_load_run", (cast: unknown) => ({ dataFileCastNumbers: cast })],
			[
				"start_load_run",
				(cast: unknown) => ({
					scenario: { collectionId: "c1", dataFileCastNumbers: cast },
				}),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args(true)).success, name).toBe(true);
			expect(schemaOf(name).safeParse(args(false)).success, name).toBe(true);
			expect(schemaOf(name).safeParse(args("true")).success, name).toBe(false);
		}
	});

	test("the schema refuses a hash that is not 64 lowercase hex, on every tool that takes one", () => {
		const schemaOf = (name: string) =>
			z.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>);
		const hash = "c".repeat(64);
		const cases = [
			["run_collection", (dataFileHash: string) => ({ collectionId: "c1", dataFileHash })],
			["start_load_run", (dataFileHash: string) => ({ dataFileHash })],
			[
				"start_load_run",
				(dataFileHash: string) => ({ scenario: { collectionId: "c1", dataFileHash } }),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args(hash)).success, name).toBe(true);
			for (const bad of ["C".repeat(64), "abc", "/home/u/users.csv"]) {
				expect(schemaOf(name).safeParse(args(bad)).success, `${name} ${bad}`).toBe(false);
			}
		}
	});

	// A display name, never a path (#2051), refused before the engine has to.
	// Mutation check: drop the regex from `dataFileNameInput` and every path
	// case passes the schema.
	test("the schema refuses a path as a file name, pointing at dataFile.fileName", () => {
		const schemaOf = (name: string) =>
			z.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>);
		const cases = [
			["run_collection", (dataFileName: string) => ({ collectionId: "c1", dataFileName })],
			["start_load_run", (dataFileName: string) => ({ dataFileName })],
			[
				"start_load_run",
				(dataFileName: string) => ({ scenario: { collectionId: "c1", dataFileName } }),
			],
		] as const;
		for (const [name, args] of cases) {
			expect(schemaOf(name).safeParse(args("users.csv")).success, name).toBe(true);
			for (const path of ["/home/u/users.csv", "exports/users.csv", "C:\\data\\users.csv"]) {
				const parsed = schemaOf(name).safeParse(args(path));
				expect(parsed.success, `${name} ${path}`).toBe(false);
				expect(parsed.error?.issues[0].message).toMatch(/never a path.*dataFile\.fileName/);
			}
		}
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

	test("forwards a timers override - the design-mode runner still waits on timer.pacing", async () => {
		// Unlike scripts (load-run only), execute_scenario_run wires
		// RunContext::timers_override into the same ExchangeInputs a scenario
		// load run does, so "off" is a real control here, not a no-op.
		const client = scenarioClient();
		const res = await dispatchTool(
			"run_collection",
			{ collectionId: "c1", elements: { timers: "off" } },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(payload.elements).toEqual({ timers: "off" });
	});

	test("offers no scripts control - it has no effect on a design-mode run", () => {
		// scripts_override's one reader is replay_scenario_steps, the load
		// path's own post-run replay; run_collection never reads it, so
		// offering the control here would be an argument written and never
		// read.
		const tool = TOOLS.find((t) => t.name === "run_collection");
		const elementsShape = (
			tool!.inputSchema.elements as z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>>
		)._def.innerType.shape;
		expect(Object.keys(elementsShape)).toEqual(["timers"]);
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

	test("the refusal names the host and withholds the resolved URL (#1892)", async () => {
		const client = scenarioClient({
			getGlobals: vi.fn().mockResolvedValue({
				id: "globals",
				variables: { api_key: { value: "SECRETVALUE", secret: true, enabled: true } },
			}),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x?api_key=SECRETVALUE"
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
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).not.toMatch(/SECRETVALUE/);
		expect(client.startRun).not.toHaveBeenCalled();
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
	 * The pre-flight walk has to visit steps in `collect_requests`' order, or its
	 * "first bad step" names a step the run reaches later. Every row here sits at
	 * 0, so the kind rank puts each folder's subtree ahead of its parent's own
	 * request; the interleaved shapes are `sibling-order.conformance.test.ts`'s.
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
		// The report's own bound, stated where the agent reads the run id: the
		// rows are the stored steps, and resultsStored/resultsCap say if cut.
		expect(firstText(res)).toMatch(/every stored step row/);
		expect(firstText(res)).toMatch(/resultsStored/);
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
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>;
			const scenario = shapeOf("run_collection").failOnSchemaError.description ?? "";
			const smoke = shapeOf("run_collection_smoke").failOnSchemaError.description ?? "";
			expect(scenario).toContain("fails its step (default false)");
			expect(smoke).toContain("fails its request (default true)");
		});
	});

	/**
	 * Ending an iteration at a script error (issue #2526). Top-level beside
	 * `scenario`, like `failOnSchemaError`, and sent only when true: the engine's
	 * default is false, so a stored payload carries the key exactly when it
	 * changed what ended an iteration.
	 */
	describe("stopOnError", () => {
		async function runWith(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			return { res, payload };
		}

		test("reaches POST /runs top-level, not inside the scenario block", async () => {
			const { payload } = await runWith({ stopOnError: true });
			expect(payload.stopOnError).toBe(true);
			expect(payload.scenario).not.toHaveProperty("stopOnError");
		});

		test.each([
			["omitted", {}],
			["false", { stopOnError: false }],
		])("is absent from the payload when the caller passed %s", async (_label, args) => {
			const { payload } = await runWith(args);
			expect(payload).not.toHaveProperty("stopOnError");
		});

		test("the tool and its next step tell an agent what an error costs", async () => {
			const tool = TOOLS.find((t) => t.name === "run_collection")!;
			expect(tool.description).toContain("stopOnError");
			expect(tool.description).toContain("stepsNotRun");
			const shape = tool.inputSchema as Record<string, z.ZodType>;
			expect(shape.stopOnError.description).toMatch(/script error/);

			const { res } = await runWith({});
			expect(firstText(res)).toContain("stepsNotRun");
		});
	});

	/**
	 * Pass/fail budgets (issue #1564): the engine now judges a design-mode
	 * collection run against `thresholds` exactly as it always has a load run,
	 * so this tool takes the same argument `start_load_run` does and forwards
	 * it verbatim.
	 */
	describe("thresholds", () => {
		async function payloadFor(args: Record<string, unknown>) {
			const client = scenarioClient();
			const res = await dispatchTool(
				"run_collection",
				{ collectionId: "c1", ...args },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			return { res, client };
		}

		test("forwards a declared budget to POST /runs unchanged", async () => {
			const { res, client } = await payloadFor({
				thresholds: { maxErrorRatePct: 0.1, failRun: true },
			});
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			expect(payload.thresholds).toEqual({ maxErrorRatePct: 0.1, failRun: true });
		});

		test("is absent from the payload when the caller named none", async () => {
			const { res, client } = await payloadFor({});
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as Record<string, unknown>;
			expect(payload).not.toHaveProperty("thresholds");
		});

		test("shares its schema with start_load_run's own thresholds argument", () => {
			const shapeOf = (name: string) =>
				TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>;
			expect(shapeOf("run_collection").thresholds).toBe(shapeOf("start_load_run").thresholds);
		});

		// Mutation check: drop the populations sentence from `thresholdsInput` and
		// this fails. An agent that reads only the argument must learn that the
		// assertion budget judges the worse of the exact and sampled populations
		// (#2892).
		test("describes the assertion budget's two populations (#2892)", () => {
			const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
				string,
				z.ZodType
			>;
			const description = shape.thresholds.description ?? "";
			expect(description).toContain(
				"judges the worse of the exact inline assertions and the sampled"
			);
			for (const key of ["assertionsExact", "assertionsSampled", "sampleRate"]) {
				expect(description).toContain(key);
			}
		});
	});
});

describe("start_load_run headers (#2466)", () => {
	const allowed = { allowlist: ["api.example.com"] };
	const composeClient = () =>
		fakeClient({
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
		});
	const composedRequest = (client: EngineClient) =>
		(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].request as Record<
			string,
			unknown
		>;
	const send = (client: EngineClient, headers: unknown) =>
		dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com/x",
				headers,
				mode: "constant_concurrency",
				concurrency: 1,
				duration: "5s",
				confirmed: true,
			},
			ctxWith(client, allowed)
		);

	test("takes ordered lines and composes them as given", async () => {
		const client = composeClient();
		const lines = [
			{ name: "Link", value: "<a>; rel=next" },
			{ name: "Link", value: "<b>; rel=prev" },
		];
		const res = await send(client, lines);
		expect(res.isError).toBeFalsy();
		expect(composedRequest(client).headers).toEqual(lines);
	});

	test("still takes the string map", async () => {
		const client = composeClient();
		const res = await send(client, { "X-Tenant": "acme" });
		expect(res.isError).toBeFalsy();
		expect(composedRequest(client).headers).toEqual({ "X-Tenant": "acme" });
	});

	test("declares both shapes in the schema the client reads", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.headers.safeParse([{ name: "A", value: "1" }]).success).toBe(true);
		expect(shape.headers.safeParse({ A: "1" }).success).toBe(true);
		expect(shape.headers.safeParse([{ name: "A" }]).success).toBe(false);
	});
});

describe("start_load_run scenario runs", () => {
	function scenarioLoadClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
		return fakeClient({
			listEnvironments: listingEnv1(),
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
			origin: { kind: "mcp" },
			targetPolicy: { allowAll: false, allowedHosts: ["api.example.com"] },
		});
	});

	test("forwards scenario.dataFileName, dataFileHash and dataFileCastNumbers inside the block (#2051)", async () => {
		const client = scenarioLoadClient();
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: {
					collectionId: "c1",
					data: rows,
					dataFileName: "users.csv",
					dataFileHash: hash,
					dataFileCastNumbers: true,
				},
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.scenario).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
		expect(payload).not.toHaveProperty("dataFileName");
	});

	test("an un-allowlisted step's refusal names the host and withholds the resolved URL (#1892)", async () => {
		const client = scenarioLoadClient({
			getGlobals: vi.fn().mockResolvedValue({
				id: "globals",
				variables: { api_key: { value: "SECRETVALUE", secret: true, enabled: true } },
			}),
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r1", name: "login" },
				{ id: "r2", name: "offsite" },
			]),
			composeRequest: vi.fn().mockImplementation(({ requestId }: { requestId: string }) =>
				Promise.resolve({
					method: "GET",
					url:
						requestId === "r2"
							? "https://evil.test/x?api_key=SECRETVALUE"
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
		expect(firstText(res)).toMatch(/evil\.test/);
		expect(firstText(res)).not.toMatch(/SECRETVALUE/);
		expect(client.startRun).not.toHaveBeenCalled();
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
			// The single-target row set (issue #993): a sequence states its rows
			// as `scenario.data`, and they bind per iteration there rather than
			// per request sent, so a payload carrying both would have one of the
			// two silently dropped.
			["data", [{ id: "1" }]],
			// And the single-target file name and hash beside it (issue #2051):
			// a sequence names its rows' file inside the block.
			["dataFileName", "users.csv"],
			["dataFileHash", "c".repeat(64)],
			["dataFileCastNumbers", true],
			// The send's default-header refusals (issue #1337): the engine reads
			// them off one request's payload, and a scenario's steps are each
			// composed from their own saved request, so a run-level list would be
			// an argument written and never read.
			["disabledDefaultHeaders", ["User-Agent"]],
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

	test("forwards the timers/scripts override on a scenario run", async () => {
		// The engine's validator owns the shape and the value ranges
		// (issue #1495) - this layer only has to get the keys to it unchanged.
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				elements: { timers: "off", scripts: "allInline" },
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.elements).toEqual({ timers: "off", scripts: "allInline" });
	});

	test("sends no elements key when none was declared", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		const parsed = z.object(shape).parse({ scenario: { collectionId: "c1" } });
		expect(parsed.elements).toBeUndefined();
	});

	test("rejects an elements value the engine does not accept", () => {
		// The engine's set is closed (asConfigured|off, asMarked|allInline|
		// allDeferred); a typo should be caught here rather than reaching
		// POST /runs as an unrecognised value.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		const schema = z.object(shape);
		expect(() =>
			schema.parse({ scenario: { collectionId: "c1" }, elements: { timers: "disabled" } })
		).toThrow();
		expect(() =>
			schema.parse({ scenario: { collectionId: "c1" }, elements: { scripts: "inline" } })
		).toThrow();
	});

	// Issue #1594: a single target's own `requestElements` now has a pipeline
	// for the run-level override to reach, so `elements` is accepted here too,
	// not only beside `scenario`.
	test("accepts an elements override on a single-target run", async () => {
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/x", elements: { timers: "off" }, confirmed: true },
			ctxWith(client, allowed)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(payload.elements).toEqual({ timers: "off" });
	});

	test("declares elements as usable on both a scenario and a single target", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.elements).toBeDefined();
		expect(shape.elements.description).not.toMatch(/Scenario runs only/);
		// The positive half: not merely "doesn't say scenario-only" (which an
		// empty or unrelated description would also pass), but actually says
		// the single-target case works.
		expect(shape.elements.description).toMatch(/single target/i);
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
			z.ZodType
		>;
		expect(shape.failOnSchemaError).toBeDefined();
		expect(shape.failOnSchemaError.description).toMatch(/Not available on a load run/);
	});

	/**
	 * `stopOnError` is the design-mode runner's too (issue #2526), refused on the
	 * same terms and for the same reason: declared so the SDK does not strip it
	 * before the handler can say no.
	 */
	test.each([
		["a scenario", { scenario: { collectionId: "c1" } }],
		["a single target", { url: "https://api.example.com/x" }],
	])("refuses stopOnError beside %s, pointing at run_collection", async (_label, target) => {
		const client = scenarioLoadClient();
		for (const value of [true, false]) {
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, stopOnError: value, confirmed: true },
				ctxWith(client, allowed)
			);
			expect(res.isError, String(value)).toBe(true);
			expect(firstText(res), String(value)).toContain('"stopOnError"');
			expect(firstText(res), String(value)).toMatch(/run_collection/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
		expect(client.composeRequest).not.toHaveBeenCalled();
	});

	test("declares stopOnError so the refusal survives schema validation", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.stopOnError).toBeDefined();
		expect(shape.stopOnError.description).toMatch(/Not available on a load run/);
	});

	test("refuses the two modes the engine cannot drive, with its reasoning", async () => {
		const client = scenarioLoadClient();
		const capacity = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "c1" }, mode: "capacity", confirmed: true },
			ctxWith(client, allowed)
		);
		expect(capacity.isError).toBe(true);
		expect(firstText(capacity)).toMatch(/one p99 per level/);
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

	test("refuses a cloud-metadata monitor URL before anything is started", async () => {
		const client = scenarioLoadClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				scenario: { collectionId: "c1" },
				monitor: { url: "http://169.254.169.254/latest/meta-data/", series: ["up"] },
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/not on the MCP allowlist/i);
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

	test("a declined question starts nothing", async () => {
		const client = scenarioLoadClient();
		const ctx = ctxAsking(client, allowed, { confirm: { action: "decline" } });
		const res = await dispatchTool("start_load_run", { scenario: { collectionId: "c1" } }, ctx);
		expect(firstText(res)).toMatch(/declined/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("the scenario block offers no iterations of its own", () => {
		// A load run reads the top-level `iterations`; `scenario.iterations` is the
		// design runner's pass count and the load executor never looks at it, so
		// offering it here would be an argument written and never read.
		const tool = TOOLS.find((t) => t.name === "start_load_run");
		const shape = (
			tool!.inputSchema.scenario as z.ZodOptional<z.ZodObject<Record<string, z.ZodType>>>
		)._def.innerType.shape;
		expect(Object.keys(shape).sort()).toEqual([
			"collectionId",
			"data",
			"dataFileCastNumbers",
			"dataFileHash",
			"dataFileName",
			"recursive",
		]);
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
			z.ZodType
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
		const head = "POST /x HTTP/2\r\nHost: api.example.com\r\nX-Trace: abc\r\n\r\n";
		const out = await runRequest(executed(executeAnswer({ rawRequest: head + huge })));

		const raw = out.rawRequest as string;
		expect(raw.startsWith(head)).toBe(true);
		expect(raw).toContain("X-Trace: abc");
		expect(Buffer.byteLength(raw, "utf8")).toBe(head.length + MAX_INLINE_BODY_BYTES);
		expect(out.rawRequestTruncated).toBe(true);
		expect(out.rawRequestBytes).toBe(head.length + huge.length);
	});

	test("run_request does not touch a headers-only rawRequest", async () => {
		const answer = executeAnswer({ rawRequest: "GET /x HTTP/2\r\nHost: api.example.com\r\n" });
		expect(await runRequest(executed(answer))).toEqual(answer);
	});

	test("run_request keeps the engine's bodyCapped distinct from its own cut", async () => {
		// Two different facts about one body (issue #1157). `bodyTruncated` is
		// this result showing less than the engine returned - the app's history
		// still has the rest. `bodyCapped` is the engine never having read more,
		// which a re-send reproduces. An agent that saw only the first flag would
		// keep re-sending a request that cannot return more.
		const out = await runRequest(
			executed(executeAnswer({ bodyRaw: huge, bodySize: huge.length, bodyCapped: true }))
		);

		expect(out.bodyCapped).toBe(true);
		expect(out.bodyTruncated).toBe(true);
	});

	test("run_request carries bodyCapped: false through untouched", async () => {
		// Always present on the wire, so "not capped" must stay distinguishable
		// from an engine too old to say. The bound must not eat the key.
		const answer = executeAnswer({ bodyRaw: "{}", bodySize: 2, bodyCapped: false });
		const out = await runRequest(executed(answer));

		expect(out).toEqual(answer);
		expect(out.bodyCapped).toBe(false);
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

	describe("a base64 body (#2458)", () => {
		/** Bytes that are not UTF-8 text, as the engine answers them. */
		const bytesOf = (count: number) =>
			Buffer.from(Array.from({ length: count }, (_, i) => i % 256));
		const base64Answer = (bytes: Buffer) =>
			executeAnswer({
				bodyRaw: bytes.toString("base64"),
				bodyEncoding: "base64",
				bodySize: bytes.length,
				headers: { "content-type": "image/png" },
			});

		test("is cut on a whole 4-character group and still decodes", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 5_001);
			const out = await runRequest(executed(base64Answer(bytes)));

			const cut = out.bodyRaw as string;
			expect(cut.length % 4).toBe(0);
			// Strict: `atob` throws on a length the groups cannot make up.
			const decoded = Buffer.from(atob(cut), "latin1");
			expect(decoded.length).toBeLessThanOrEqual(MAX_INLINE_BODY_BYTES);
			expect(decoded.length).toBeGreaterThan(MAX_INLINE_BODY_BYTES - 3);
			expect(decoded.equals(bytes.subarray(0, decoded.length))).toBe(true);
			expect(out.bodyEncoding).toBe("base64");
			expect(out.bodyTruncated).toBe(true);
			expect(out.bodySize).toBe(bytes.length);
			expect(out.body).toBeNull();
		});

		test("is bounded by its decoded size, not by its text", async () => {
			// 40,000 characters of base64 over 30,000 bytes: past the bound as
			// text, inside it as the body it is.
			const answer = base64Answer(bytesOf(30_000));
			expect((answer.bodyRaw as string).length).toBeGreaterThan(MAX_INLINE_BODY_BYTES);
			expect(await runRequest(executed(answer))).toEqual(answer);
		});

		test("states its decoded size when the engine sent none", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 2);
			const answer: Record<string, unknown> = base64Answer(bytes);
			delete answer.bodySize;
			const out = await runRequest(executed(answer));
			// `=` padding carries no bytes: 32,770 bytes end in one `=`.
			expect((answer.bodyRaw as string).endsWith("=")).toBe(true);
			expect(out.bodySize).toBe(bytes.length);
		});

		test("a utf8 answer over the bound is cut as text, its encoding kept", async () => {
			const out = await runRequest(
				executed(
					executeAnswer({ bodyRaw: huge, bodySize: huge.length, bodyEncoding: "utf8" })
				)
			);
			expect(Buffer.byteLength(out.bodyRaw as string, "utf8")).toBe(MAX_INLINE_BODY_BYTES);
			expect(out.bodyEncoding).toBe("utf8");
		});

		test("on a stored trace node is cut the same way, with its decoded size", async () => {
			const bytes = bytesOf(MAX_INLINE_BODY_BYTES + 5_001);
			const out = await runReport(
				reported({
					results: [
						{
							id: 1,
							trace: {
								response: {
									body: bytes.toString("base64"),
									bodyEncoding: "base64",
								},
							},
						},
					],
				})
			);

			const response = (out.results as Row[])[0].trace!.response!;
			const cut = response.body as string;
			expect(cut.length % 4).toBe(0);
			expect(
				Buffer.from(atob(cut), "latin1").equals(bytes.subarray(0, (cut.length / 4) * 3))
			).toBe(true);
			expect(response.bodyEncoding).toBe("base64");
			expect(response.bodyTruncated).toBe(true);
			expect(response.bodyBytes).toBe(bytes.length);
		});
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

	// Mutation check (#2820): have boundRunReport or markPartialReport rebuild the
	// report without its `scenario` section and this fails.
	test("get_run_report hands a scenario load report's assertions through unchanged", async () => {
		const scenario = { passed: 4590, failed: 0, assertions: { passed: 10, failed: 4580 } };
		const out = await runReport(reported({ summary: { errorRate: 0 }, scenario, results: [] }));

		expect(out.scenario).toEqual(scenario);
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
			const description = descriptionOf(TOOLS.find((t) => t.name === name));
			expect(description).toContain(String(MAX_INLINE_BODY_BYTES));
			expect(description).toMatch(/bodyTruncated/);
		}
	});

	test("run_request's description tells the two body flags apart", () => {
		// The flags are one word apart and mean opposite things about what a
		// re-send would achieve, so the description has to name both and say
		// which remedy belongs to which.
		const description = descriptionOf(TOOLS.find((t) => t.name === "run_request"));
		expect(description).toMatch(/bodyCapped/);
		expect(description).toMatch(/maxDesignResponseBodyBytes/);
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
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
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

	/**
	 * Every tool that accepts a `bodyType` states the GraphQL GET transport
	 * rule, and the list is *discovered* rather than spelled out: #1228 wrote
	 * the sentence into three descriptions by name and `start_load_run` - which
	 * offers `graphql` like the rest and is exactly where the rule bites, since
	 * a run left on the default GET sends no body at all - kept a description
	 * that never mentioned a method (#1277). The rule is asserted against every
	 * `bodyType` the schema actually offers rather than a list written here, so
	 * a fifth such tool is checked the moment it exists; the four names are the
	 * separate guard that the scan found the set it thinks it found, and a new
	 * tool joining that list is the deliberate moment to read the rule again.
	 */
	describe("the GraphQL GET transport rule", () => {
		const bodyTypeDescriptions = () =>
			TOOLS.flatMap((tool) => {
				const schema = tool.inputSchema as Record<string, { description?: string }>;
				const description = schema?.bodyType?.description;
				return description ? [[tool.name, description] as const] : [];
			});

		test("is stated by every tool that accepts a bodyType", () => {
			const found = bodyTypeDescriptions();
			// The scan is worthless if it scanned nothing - the failure mode a
			// source-shaped guard hides behind (see CLAUDE.md).
			expect(found.map(([name]) => name).sort()).toEqual([
				"create_request",
				"run_request",
				"start_load_run",
				"update_request",
			]);
			for (const [name, description] of found) {
				// The three facts an agent needs to pick a method: that graphql
				// is on offer, which verb carries the document in the URL and
				// what it becomes there, and which verb a mutation needs. The
				// wording differs per tool; these are the facts, not a copy.
				expect(description, `${name} names graphql`).toContain("graphql");
				expect(description, `${name} names GET`).toMatch(/\bGET\b/);
				expect(description, `${name} names the query parameters`).toContain(
					"query parameters"
				);
				expect(description, `${name} names POST`).toMatch(/\bPOST\b/);
			}
		});
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

	test("run_request folds an ad-hoc pre/post script into elements, never as a raw field", async () => {
		// Parsed through the tool's own inputSchema first, because that is the
		// only thing standing between the agent and the engine: `registerTool`
		// hands the SDK this shape, and a zod object *strips* keys it does not
		// declare. dispatchTool alone does not validate, so asserting on it
		// would pass with the field removed and prove nothing.
		//
		// The raw fields must never reach `/execute`: issue #1514 refuses
		// `preRequestScript` / `postRequestScript` there outright, so a
		// forwarded string would 400 rather than sign the request.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const args = z.object(tool!.inputSchema as Record<string, z.ZodType>).parse({
			url: "https://api.example.com/users",
			preRequestScript: "pm.request.headers['X-Signature'] = 'abc';",
			postRequestScript: "pm.test('ok', function () {});",
		});

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// Both ride as `elements` now (issue #1514): `/compose` copies an inline
		// request's keys onto the payload verbatim, so sending the retired names
		// would reach `/execute` and come back a 400. Ids are stated because
		// nothing assigns one on this path and per-element outcomes key off it.
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-pre",
				kind: "script.pre",
				enabled: true,
				config: { script: "pm.request.headers['X-Signature'] = 'abc';" },
			},
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
		]);
		expect(payload.preRequestScript).toBeUndefined();
		expect(payload.postRequestScript).toBeUndefined();
	});

	test("run_request appends an ad-hoc `elements` argument alongside its own scripts", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{
				url: "https://api.example.com/users",
				postRequestScript: "pm.test('ok', function () {});",
				elements: [{ kind: "assert.duration", config: { maxMs: 500 } }],
			},
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		// The ad-hoc `elements` argument (issue #1517) joins the script, never
		// replacing it - there is no stored chain for this tool to lose either
		// way (composition here is always inline).
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
			{ kind: "assert.duration", config: { maxMs: 500 } },
		]);
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
		const args = z.object(tool!.inputSchema as Record<string, z.ZodType>).parse({
			url: "https://api.example.com/users",
			allowScriptRequests: true,
			preRequestScript: "pm.sendRequest('https://evil.example.com', function () {});",
		});
		expect(args).not.toHaveProperty("allowScriptRequests");

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("allowScriptRequests");
	});

	test("run_request keeps the engine's parsed body: it never sends includeParsedBody (issue #2544)", async () => {
		// The renderer declines the parsed copy because its pane reads `bodyRaw`;
		// this tool's result exposes `body`, so the engine's default (true) is the
		// behaviour it needs. An agent cannot decline it either: the field is not
		// in the schema, so zod strips it.
		const tool = TOOLS.find((t) => t.name === "run_request");
		const args = z.object(tool!.inputSchema as Record<string, z.ZodType>).parse({
			url: "https://api.example.com/users",
			includeParsedBody: false,
		});
		expect(args).not.toHaveProperty("includeParsedBody");

		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).not.toHaveProperty("includeParsedBody");
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
		expect(descriptionOf(loadRun)).toMatch(/scenario/i);
		expect(descriptionOf(loadRun)).toMatch(/virtual users/);
		expect(descriptionOf(loadRun)).not.toMatch(/cannot be started from here/);
		expect(Object.keys(loadRun!.inputSchema)).toContain("scenario");
	});

	test("start_load_run names the simulated-user count 'virtual users', not in-flight or concurrency (#2128)", () => {
		// The app's one word for this number. The parameter names keep
		// `concurrency`; their descriptions are what an agent reads, so they carry
		// the same wording the UI does.
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		for (const field of ["concurrency", "startConcurrency", "stepDuration"]) {
			expect(shape[field].description, field).toMatch(/virtual user/i);
		}
		// `concurrency` is not a rate-paced run's target, and the description says so.
		expect(shape.concurrency.description).toMatch(/constant_rps/);
		expect(shape.concurrency.description).not.toMatch(/^Target in-flight requests/);
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
				z.ZodType
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
			.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>)
			.parse(args);

	test("start_load_run sends postRequestScript to /runs as a script.post element", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				postRequestScript: "pm.test('ok', function () {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.requestElements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('ok', function () {});" },
			},
		]);
		// The retired flat field (issue #1594's cut-over): POST /runs refuses it
		// by name now, so it must never be built for this payload.
		expect(payload.tests).toBeUndefined();
		expect(payload.postRequestScript).toBeUndefined();
	});

	test("start_load_run defers the {{$guid}} family to per-iteration generation", async () => {
		// A load run repeats this composed payload once per iteration, per
		// virtual user, so the generator family must not be resolved at this
		// one-time composition (issue #995).
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(composeBody.deferDynamicVariables).toBe(true);
	});

	describe("start_load_run tells /compose which bare names are data columns (issue #2956)", () => {
		// Without `dataColumns` the engine cannot tell a bare `{{email}}` meant
		// for the row from one meant for the environment, and the environment
		// variable of the same name answers at composition.
		const composedWith = async (data: unknown) => {
			const client = fakeClient();
			await composeLoadRunRequest(
				{ url: "https://api.example.com", data },
				ctxWith(client, { allowlist: ["api.example.com"] })
			);
			return (client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		};

		test("sends the union of every row's keys, first seen first", async () => {
			// Ragged rows: the engine binds the union, so the second row's `plan`
			// and the third row's `region` must not be lost to a first-row read.
			const composeBody = await composedWith([
				{ email: "a@example.com", id: 1 },
				{ email: "b@example.com", plan: "pro" },
				{ id: 3, region: "eu" },
			]);

			expect(composeBody.dataColumns).toEqual(["email", "id", "plan", "region"]);
		});

		test("skips a row that is not an object, and an empty key", async () => {
			const composeBody = await composedWith([
				"stray",
				null,
				["array"],
				{ email: "a@example.com", "": "unnamed" },
			]);

			expect(composeBody.dataColumns).toEqual(["email"]);
		});

		test.each([
			["no data", undefined],
			["an empty data array", []],
			["rows with no keys", [{}, {}]],
			["rows that are not objects", ["x", 1]],
		])("sends no dataColumns key for %s", async (_label, data) => {
			const composeBody = await composedWith(data);

			expect("dataColumns" in composeBody).toBe(false);
		});

		test("reaches the engine through the tool, from the parsed data argument", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					confirmed: true,
					data: [{ email: "a@example.com" }],
				}),
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBeFalsy();
			const composeBody = (client.composeRequest as ReturnType<typeof vi.fn>).mock
				.calls[0][0];
			expect(composeBody.dataColumns).toEqual(["email"]);
		});
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

	test("start_load_run forwards a custom.<name>.<stat> threshold key (issue #1500)", async () => {
		// Zod's object() strips any key it doesn't name by default, which would
		// silently drop this budget before it ever reached POST /runs. The
		// engine's own validate_thresholds is the real gate on the key's shape.
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				thresholds: { "custom.ttfb2.p95": 50 },
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.thresholds).toEqual({ "custom.ttfb2.p95": 50 });
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

	test.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://[fd00:ec2::254]/latest/meta-data/",
	])(
		"start_load_run refuses the cloud-metadata monitor %s before starting the run",
		async (url) => {
			// A private address, but one that serves credentials rather than the
			// user's exporter, so it needs the allowlist entry a public host does (#2370).
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				parseArgs("start_load_run", {
					url: "https://api.example.com",
					confirmed: true,
					monitor: { url, series: ["up"] },
				}),
				ctxWith(client, { allowlist: ["api.example.com"] })
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not on the MCP allowlist/i);
			expect((client.startRun as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
		}
	);

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

	test("start_load_run still accepts the agent argument name `tests` as the same script", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				tests: "pm.test('a', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.requestElements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('a', () => {});" },
			},
		]);
		expect(payload.tests).toBeUndefined();
	});

	test("run_request accepts `tests` as the same script as postRequestScript", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", {
				url: "https://api.example.com/users",
				tests: "pm.test('b', () => {});",
			}),
			ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The alias resolves to the same `script.post` element the other name
		// builds - one concept, one wire shape.
		expect(payload.elements).toEqual([
			{
				id: "mcp-script-post",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('b', () => {});" },
			},
		]);
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
				ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
			);

			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/i);
			expect(client.startRun).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
		}
	);

	/*
	 * #1834: with Reveal secrets to agents off, an agent-written script is
	 * refused before anything is composed or sent, because a script reads every
	 * variable the request resolves against, secret ones included.
	 */
	describe("agent-supplied scripts while Reveal secrets to agents is off", () => {
		const target = { url: "https://api.example.com/users", confirmed: true };
		const OFF = { allowlist: ["api.example.com"] };
		const ON = { allowlist: ["api.example.com"], revealSecretsToAgents: true };
		const script = (kind: string, text = "pm.environment.get('token');") => ({
			kind,
			config: { script: text },
		});

		const expectRefusedUntouched = (
			res: { isError?: boolean; content: Array<{ text: string }> },
			client: EngineClient,
			named: string
		) => {
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain(named);
			expect(firstText(res)).toContain("Reveal secrets to agents");
			expect(client.composeRequest).not.toHaveBeenCalled();
			expect(client.executeRequest).not.toHaveBeenCalled();
			expect(client.startRun).not.toHaveBeenCalled();
		};

		test.each([
			["preRequestScript", { preRequestScript: "pm.request.headers.add('a', 'b')" }],
			["postRequestScript", { postRequestScript: "pm.test('ok', () => {})" }],
			["tests", { tests: "pm.test('ok', () => {})" }],
			["elements", { elements: [script("script.pre")] }],
			["elements", { elements: [script("script.post")] }],
			["elements", { elements: [script("script.setup")] }],
			["elements", { elements: [script("script.teardown")] }],
			["elements", { elements: [script("SCRIPT.Pre")] }],
			["elements", { elements: [script("  script.post ")] }],
			[
				"elements",
				{
					elements: [
						{ kind: "assert.duration", config: { maxMs: 5 } },
						script("script.pre"),
					],
				},
			],
			["elements", { elements: [{ ...script("script.pre"), enabled: false }] }],
		])("run_request refuses %s", async (named, extra) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, ...extra },
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, `"${named}"`);
		});

		test("run_request names every offending argument", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					...target,
					preRequestScript: "a();",
					postRequestScript: "b();",
					elements: [script("script.post")],
				},
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(
				res,
				client,
				'"preRequestScript", "postRequestScript", "elements"'
			);
		});

		test.each([
			["postRequestScript", { postRequestScript: "pm.test('ok', () => {})" }],
			["tests", { tests: "pm.test('ok', () => {})" }],
		])("start_load_run refuses %s", async (named, extra) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{ ...target, ...extra },
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, `"${named}"`);
		});

		test("start_load_run refuses a script override of a saved request, too", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					requestId: "req_1",
					postRequestScript: "pm.test('ok', () => {})",
					confirmed: true,
				},
				ctxWith(client, OFF)
			);
			expectRefusedUntouched(res, client, '"postRequestScript"');
		});

		test.each([
			["run_request", { preRequestScript: "a();", postRequestScript: "b();" }],
			["start_load_run", { postRequestScript: "b();" }],
		])("%s sends the same scripts once reveal is on", async (name, scripts) => {
			const client = fakeClient();
			const res = await dispatchTool(name, { ...target, ...scripts }, ctxWith(client, ON));
			expect(res.isError).toBeFalsy();
			expect(client.composeRequest).toHaveBeenCalled();
		});

		test("run_request passes extractors, assertions and timers with reveal off", async () => {
			const client = fakeClient();
			const elements = [
				{ kind: "extract.jsonpath", config: { path: "$.id", variable: "id" } },
				{ kind: "assert.duration", config: { maxMs: 500 } },
				{ kind: "timer.think", config: { ms: 10 } },
			];
			const res = await dispatchTool(
				"run_request",
				{ ...target, elements },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.elements).toEqual(elements);
		});

		test.each([
			["empty", ""],
			["whitespace-only", " \t\r\n "],
		])("a %s script is inert in the engine and is not refused", async (_label, blank) => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{
					...target,
					preRequestScript: blank,
					postRequestScript: blank,
					elements: [script("script.setup", blank), { kind: "script.teardown" }],
				},
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.executeRequest).toHaveBeenCalled();
		});

		test("run_request with a url and a requestId link sends with reveal off", async () => {
			// With a `url` the send is ad hoc: `requestId` links History and composes
			// nothing stored, so no stored script rides it.
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload.requestId).toBe("req_1");
		});

		test("start_load_run of a saved request that stores scripts still runs with reveal off", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"start_load_run",
				{ requestId: "req_1", duration: "30s", confirmed: true },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.startRun).toHaveBeenCalled();
		});

		test("the descriptions say what is refused and where the setting lives", () => {
			for (const name of ["run_request", "start_load_run"]) {
				const description = descriptionOf(TOOLS.find((t) => t.name === name));
				expect(description).toContain(REVEAL_SETTING_TOKEN);
				expect(resolveRemedyTokens(description, "app")).toContain(
					"Reveal secrets to agents"
				);
				expect(description).toMatch(/script you supply here .* is refused/);
			}
		});
	});

	/*
	 * #2435: `run_request` with a `requestId` and no `url` sends the saved
	 * request as the app's Send does; with a `url` it is ad hoc and `requestId`
	 * only links the run.
	 */
	describe("run_request by saved request id", () => {
		const OFF = { allowlist: ["api.example.com"] };
		const composeBody = (client: EngineClient) =>
			(client.composeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;
		const executed = (client: EngineClient) =>
			(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;

		test("composes the stored row and executes what comes back, stored auth included", async () => {
			const auth = { mode: "bearer", token: "{{apiToken}}" };
			const client = savedRequestClient({ auth });
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", environmentId: "env_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client)).toMatchObject({
				requestId: "req_1",
				environmentId: "env_1",
			});
			// Nothing inline: the stored row defines the request.
			expect(composeBody(client).request).toBeUndefined();
			expect(executed(client)).toMatchObject({
				url: "https://api.example.com/users",
				method: "POST",
				headers: { "X-Api": "v1" },
				auth,
				requestId: "req_1",
			});
			expect(executed(client).elements).toHaveLength(3);
		});

		test("inline fields lay over the stored request without a url", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", headers: { "X-Extra": "1" }, method: "put" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).request).toEqual({
				method: "PUT",
				headers: { "X-Extra": "1" },
			});
			// Not the ad-hoc default: a stored POST must not become a GET.
			const bare = savedRequestClient();
			await dispatchTool("run_request", { requestId: "req_1" }, ctxWith(bare, OFF));
			expect(executed(bare).method).toBe("POST");
		});

		test("headers given as ordered lines reach compose as the lines, a repeat kept (#2466)", async () => {
			// Mutation check: read only the map form and the lines are dropped, so
			// compose answers the stored headers.
			const client = savedRequestClient();
			const lines = [
				{ name: "X-Dup", value: "one" },
				{ name: "x-dup", value: "two" },
				{ name: "X-Dup", value: "three" },
			];
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", headers: lines },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).request).toEqual({ headers: lines });
		});

		test("a header line that names nothing is refused by position, not forwarded", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ url: "https://api.example.com/x", headers: [{ name: "A", value: "1" }, 7] },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("headers[1]");
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("an empty url names no target, so the saved request is sent", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", url: "" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client).requestId).toBe("req_1");
			expect(composeBody(client).request).toBeUndefined();
		});

		test("ad-hoc scripts and elements follow the stored ones instead of replacing them", async () => {
			const client = savedRequestClient();
			const extractor = {
				kind: "extract.jsonpath",
				config: { path: "$.id", variable: "id" },
			};
			const res = await dispatchTool(
				"run_request",
				{
					requestId: "req_1",
					postRequestScript: "pm.test('mine', () => {})",
					elements: [extractor],
				},
				ctxWith(client, { ...OFF, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			// The engine replaces a whole inline `elements`, which would drop the chain's.
			expect(composeBody(client).request).toBeUndefined();
			const kinds = (executed(client).elements as Array<{ id?: string }>).map((e) => e.id);
			expect(kinds).toEqual(["el_chain", "el_sig", "el_own", "mcp-script-post", undefined]);
			expect((executed(client).elements as unknown[])[4]).toEqual(extractor);
		});

		test("an ad-hoc preRequestScript is composed with the stored list, so a name it sets waits for it (#2521)", async () => {
			// Mutation check: append the ad-hoc elements to the by-id composition
			// instead of composing again, and the engine never sees the script:
			// `{{token}}` goes out as the stored value it resolved before the
			// script could set it.
			const own = {
				id: "el_own",
				kind: "script.post",
				enabled: true,
				config: { script: "pm.test('own', function () {});" },
			};
			type Element = { id?: string; kind?: string };
			// The engine's rule in miniature: a `script.pre` among the composed
			// elements leaves `{{token}}` written and names it; without one the
			// stored value is resolved in.
			const composeRequest = vi
				.fn()
				.mockImplementation(({ request }: { request?: { elements?: Element[] } }) => {
					const elements = request?.elements ?? [own];
					const scripted = elements.some((el) => el.kind === "script.pre");
					return Promise.resolve({
						method: "GET",
						url: "https://api.example.com/users",
						headers: [
							{
								name: "Authorization",
								value: scripted ? "Bearer {{token}}" : "Bearer stored",
							},
						],
						elements,
						requestId: "req_1",
						...(scripted ? { deferredVariables: ["token"] } : {}),
					});
				});
			const client = fakeClient({ listEnvironments: listingEnv1(), composeRequest });
			const res = await dispatchTool(
				"run_request",
				{
					requestId: "req_1",
					environmentId: "env_1",
					preRequestScript: "pm.environment.set('token', 'new');",
				},
				ctxWith(client, { ...OFF, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			expect(composeRequest).toHaveBeenCalledTimes(2);
			const recomposed = composeRequest.mock.calls[1][0] as {
				requestId?: string;
				environmentId?: string;
				request?: { elements?: Element[] };
			};
			expect(recomposed).toMatchObject({ requestId: "req_1", environmentId: "env_1" });
			expect(recomposed.request?.elements?.map((el) => el.id)).toEqual([
				"el_own",
				"mcp-script-pre",
			]);
			expect(executed(client).headers).toEqual([
				{ name: "Authorization", value: "Bearer {{token}}" },
			]);
			expect(executed(client)).not.toHaveProperty("deferredVariables");
		});

		test("a by-id send with nothing ad hoc composes once", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.composeRequest).toHaveBeenCalledTimes(1);
		});

		test("a stored literal credential runs with reveal off and is not echoed", async () => {
			const KEY = "stored-typed-key";
			const client = fakeClient({
				composeRequest: vi.fn().mockResolvedValue({
					method: "GET",
					url: "https://api.example.com/users",
					auth: { mode: "apikey", key: "X-Stored-Key", value: KEY, in: "header" },
				}),
				executeRequest: vi.fn().mockResolvedValue({
					status: 200,
					requestHeaders: { "X-Stored-Key": KEY },
				}),
			});
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(firstText(res)).not.toContain(KEY);
			expect(JSON.parse(firstText(res)).requestHeaders).toEqual({
				"X-Stored-Key": "<redacted>",
			});
			expect(executed(client).auth).toMatchObject({ value: KEY });
		});

		test("a composed url off the allowlist is refused and nothing is executed", async () => {
			const client = savedRequestClient({ url: "https://evil.example.net/users" });
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("evil.example.net");
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("a saved request that stores scripts runs with reveal off", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(client.executeRequest).toHaveBeenCalled();
		});

		test.each([
			["preRequestScript", { preRequestScript: "pm.environment.get('t');" }],
			["elements", { elements: [{ kind: "script.post", config: { script: "pm.test()" } }] }],
		])(
			"an agent-supplied %s beside requestId is still refused with reveal off",
			async (_name, extra) => {
				const client = savedRequestClient();
				const res = await dispatchTool(
					"run_request",
					{ requestId: "req_1", ...extra },
					ctxWith(client, OFF)
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain("Nothing was sent");
				expect(client.composeRequest).not.toHaveBeenCalled();
				expect(client.executeRequest).not.toHaveBeenCalled();
			}
		);

		test("verifySSL: false is refused on this branch too", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", verifySSL: false },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("an unknown id reads as no such saved request", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "nope" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No request with id "nope"');
			expect(firstText(res)).toContain("list_requests");
			expect(client.executeRequest).not.toHaveBeenCalled();
		});

		test("url with requestId stays ad hoc: the id is a link, and a caveat says so", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ requestId: "req_1", url: "https://api.example.com/other" },
				ctxWith(client, OFF)
			);
			expect(res.isError).toBeFalsy();
			expect(composeBody(client)).not.toHaveProperty("requestId");
			expect(composeBody(client).request).toMatchObject({
				url: "https://api.example.com/other",
				method: "GET",
			});
			const payload = executed(client);
			expect(payload.requestId).toBe("req_1");
			expect(payload.url).toBe("https://api.example.com/other");
			expect(payload).not.toHaveProperty("auth");
			const caveat = res.content[res.content.length - 1].text;
			expect(caveat).toMatch(/NOT applied/);
			expect(caveat).toMatch(/Omit "url"/);
		});

		test("a url alone, or a requestId alone, carries no caveat", async () => {
			for (const args of [{ url: "https://api.example.com/users" }, { requestId: "req_1" }]) {
				const res = await dispatchTool(
					"run_request",
					args,
					ctxWith(args.url ? fakeClient() : savedRequestClient(), OFF)
				);
				expect(res.isError).toBeFalsy();
				expect(res.content).toHaveLength(1);
			}
		});

		test("neither a url nor a requestId names both ways in", async () => {
			const client = savedRequestClient();
			const res = await dispatchTool("run_request", { method: "GET" }, ctxWith(client, OFF));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(
				'Pass "url" for an ad-hoc send, or "requestId" to send a saved request.'
			);
			expect(client.composeRequest).not.toHaveBeenCalled();
		});

		test("the description and the requestId parameter state both paths", () => {
			const tool = TOOLS.find((t) => t.name === "run_request")!;
			const idDescription = (tool.inputSchema as Record<string, z.ZodType>).requestId
				.description;
			for (const text of [descriptionOf(tool), idDescription]) {
				expect(text).toMatch(/Omit `url` and pass `requestId`|Without `url`/);
				expect(text).toMatch(/nothing stored is applied/);
				expect(text).toMatch(/only links the run in History/);
			}
			expect(descriptionOf(tool)).not.toMatch(/use run_collection_smoke/);
		});
	});

	/*
	 * #1904: an extractor writes a variable, and with reveal on so may an agent's
	 * script. With write access off the engine is told to keep those values
	 * within the send; with it on the key is absent, so the engine's default
	 * (persist) applies exactly as for the app's own Send.
	 */
	describe("variables a send sets while write access is off", () => {
		const target = { url: "https://api.example.com/users" };
		const allow = ["api.example.com"];
		const extractor = {
			kind: "extract.jsonpath",
			config: { path: "$.token", variable: "token", scope: "globals" },
		};
		const executePayload = (client: EngineClient) =>
			(client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
				string,
				unknown
			>;

		test.each([
			["an extractor with reveal off", { elements: [extractor] }, {}],
			[
				"a script with reveal on",
				{ postRequestScript: "pm.environment.set('token', 'x');" },
				{ revealSecretsToAgents: true },
			],
		])(
			"a buffered run_request with %s asks the engine not to persist",
			async (_label, extra, safety) => {
				const client = fakeClient();
				const res = await dispatchTool(
					"run_request",
					{ ...target, ...extra },
					ctxWith(client, { allowlist: allow, ...safety })
				);
				expect(res.isError).toBeFalsy();
				expect(executePayload(client)).toMatchObject({
					stream: false,
					persistVariables: false,
				});
			}
		);

		test("a streaming run_request carries the same flag", async () => {
			const client = fakeClient({
				executeRequest: vi
					.fn()
					.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
				consumeStreamEvents: vi
					.fn()
					.mockResolvedValue({ events: [], completed: true, capReached: false }),
			});
			const res = await dispatchTool(
				"run_request",
				{ ...target, stream: true, elements: [extractor] },
				ctxWith(client, { allowlist: allow })
			);
			expect(res.isError).toBeFalsy();
			expect(executePayload(client)).toMatchObject({ stream: true, persistVariables: false });
		});

		test("with write access on the key is absent and the engine's default applies", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"run_request",
				{ ...target, elements: [extractor] },
				ctxWith(client, { allowlist: allow, allowWrites: true })
			);
			expect(res.isError).toBeFalsy();
			expect(executePayload(client)).not.toHaveProperty("persistVariables");
		});

		test("start_load_run is unchanged: a load run never persists, so no flag rides it", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					...target,
					confirmed: true,
					postRequestScript: "pm.environment.set('token', 'x');",
				},
				ctxWith(client, { allowlist: allow, revealSecretsToAgents: true })
			);
			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(payload).not.toHaveProperty("persistVariables");
		});

		test("the description says what write access off means for a send", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "run_request"));
			expect(description).toMatch(
				/write access off, nothing a script or extractor sets is stored/
			);
		});
	});

	test("run_request hands /compose the raw request and executes what it returns", async () => {
		// The engine resolves {{host}}; MCP must send it raw (never pre-resolved -
		// that would be a second interpolation pass) and forward the composed URL.
		const client = fakeClient({
			listEnvironments: listingEnv1(),
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
		const client = fakeClient({ listEnvironments: listingEnv1() });
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

	test("run_request answers a host left as {{baseUrl}} with the gate's own remedy (#2450)", async () => {
		// Compose leaves an undefined variable's token in place. The tool must
		// hand the agent the gate's sentence, not a generic one that drops the
		// variable's name and the tool that defines it.
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({ method: "GET", url: "{{baseUrl}}/x" }),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "{{baseUrl}}/x" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toMatch(/^Could not determine the target host/);
		expect(text).toContain("{{baseUrl}}");
		expect(text).toContain("update_collection");
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

	test("start_load_run sends the engine default duration when the cap is above it", async () => {
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
		expect(payload.duration).toBe("60s");
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
	// (`POST /compose`, #226) - the same path run_collection_smoke uses.
	//
	// Since issue #1514 `/compose` answers with `elements` and nothing else, but
	// a single-target `POST /runs` still reads only `tests` /
	// `postRequestScript(s)` (`read_post_request_script`) and never looks at
	// `elements` - so the tool folds the composed `script.post` entries back
	// into `tests` itself. Without that fold the composed assertions would be
	// sent under a key the load path ignores, which is the bug these pin.

	// Canned engine output for composing req_1 by id: what
	// request_composer_test.cpp proves the engine produces, `origin` stamps
	// included (`emit_level`).
	const composedSavedRequest = {
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
	const savedRequestClient = (composedOverrides: Record<string, unknown> = {}) =>
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
							: Promise.reject(
									new EngineRequestError("Engine responded 404", 404, "")
								)
				),
		});

	test("start_load_run composes a saved request; the chain's assertions fold into `requestElements`", async () => {
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
		// travel, in chain-then-own order, under the key /runs actually reads for
		// step-level elements (issue #1594) - not the retired flat `tests` string.
		expect(payload.requestElements).toEqual([
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
		]);
		expect(payload.tests).toBeUndefined();
		// `elements` is the run-level `timers`/`scripts` override object, a
		// different key entirely, and none was passed here.
		expect(payload.elements).toBeUndefined();
	});

	test("start_load_run reports the pre-request script it cannot run", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "30s", confirmed: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		// The `script.pre` element stays on the payload, under `requestElements`
		// (it does reach the wire now - just not this one, since it carries no
		// `config.inline` mark and no override forces it)...
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// `preRequestScripts` is refused outright now (issue #1594's cut-over),
		// so the retired name must never be sent regardless...
		expect(payload.preRequestScripts).toBeUndefined();
		// ...and `elements` is the run-level override object, not sent here
		// since no override was passed.
		expect(payload.elements).toBeUndefined();
		// ...and the agent has to be told, or a request that signs itself goes
		// out unsigned with nothing saying so. The count comes off the composed
		// `script.pre` elements now, so a miscounted fold reddens here.
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/1 pre-request script\(s\).*NOT applied/i);
	});

	// The count folds `args.elements.scripts` in, not only each element's own
	// `config.inline` - the run-level override decides every `script.pre`'s
	// fate when it is set, regardless of the mark.
	test("start_load_run suppresses the caveat when elements.scripts forces every script inline", async () => {
		const client = savedRequestClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				duration: "30s",
				confirmed: true,
				elements: { scripts: "allInline" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.elements).toEqual({ scripts: "allInline" });
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).not.toMatch(/pre-request script\(s\)/i);
	});

	// The gap the count used to miss: a `script.pre` marked `config.inline`
	// individually still does not run once the run's own override forces
	// every script deferred - so it must count as dropped too, not be
	// excluded because its own mark says otherwise.
	test("start_load_run counts even a marked script.pre as dropped when elements.scripts forces every script deferred", async () => {
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://api.example.com/x",
				requestId: "req_1",
				elements: [
					{
						id: "el_sig",
						kind: "script.pre",
						enabled: true,
						config: { script: "pm.request.headers['X-Sig'] = 'abc';", inline: true },
					},
				],
			}),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				duration: "30s",
				confirmed: true,
				elements: { scripts: "allDeferred" },
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const text = res.content.map((c) => c.text).join("\n");
		expect(text).toMatch(/1 pre-request script\(s\).*NOT applied/i);
	});

	// Under either agent-facing name - `postRequestScript` is the one both
	// execute-shaped tools declare, `tests` the engine spelling kept as an alias.
	test.each(["postRequestScript", "tests"])(
		"start_load_run: an explicit %s becomes the run's validation script",
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
				ctxWith(client, { allowlist: ["api.example.com"], revealSecretsToAgents: true })
			);

			expect(res.isError).toBeFalsy();
			const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			// Replaces rather than joins: with no way to know which the agent
			// meant, running both would add assertions they never asked for. The
			// composed `script.post` elements must not survive alongside it - only
			// the composed `script.pre` (untouched) and the ad-hoc script remain.
			expect(payload.requestElements).toEqual([
				{
					id: "el_sig",
					kind: "script.pre",
					enabled: true,
					config: { script: "pm.request.headers['X-Sig'] = 'abc';" },
					origin: { kind: "request", id: "req_1" },
				},
				{
					id: "mcp-script-post",
					kind: "script.post",
					enabled: true,
					config: { script: "pm.test('adhoc', function () {});" },
				},
			]);
			expect(payload.tests).toBeUndefined();
			expect(payload.postRequestScripts).toBeUndefined();
			expect(payload.elements).toBeUndefined();
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
		// Only the stated field is overridden; the rest of the request stands -
		// the whole composed element list included, unchanged, under the key
		// /runs reads for step-level elements.
		expect(payload.method).toBe("POST");
		expect(payload.requestElements).toEqual(composedSavedRequest.elements);
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
		// Only the stated field is overridden; the rest of the request stands -
		// the whole composed element list included, unchanged, under the key
		// /runs reads for step-level elements.
		expect(payload.url).toBe("https://api.example.com/users");
		expect(payload.requestElements).toEqual(composedSavedRequest.elements);
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
	 * Issue #2162: the stopped short run against the long one reads as a
	 * regression in every delta, so the tool returns the reasons it is not one
	 * and its description tells the agent to read them first.
	 */
	test("compare_runs returns comparability and tells the agent to read it first", async () => {
		const reports: Record<string, unknown> = {
			run_a: {
				metadata: { status: "completed", configuration: { concurrency: 10 } },
				summary: { avgRps: 100, testDuration: 20 },
			},
			run_b: {
				metadata: { status: "stopped", configuration: { concurrency: 50 } },
				summary: { avgRps: 40, testDuration: 3 },
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
			comparability: [
				{ code: "concurrency", base: "10", target: "50" },
				{ code: "duration", base: "20 s", target: "3 s, stopped" },
				{ code: "status", base: "Completed", target: "Stopped" },
			],
		});
		expect(descriptionOf(TOOLS.find((t) => t.name === "compare_runs"))).toMatch(
			/Read comparability before the deltas/
		);
	});

	// #2438: a mismatched pair is refused before any delta leaves.
	describe("compare_runs and the run type", () => {
		const report = (runType: string | undefined, avgRps: number) => ({
			metadata: { status: "completed", ...(runType ? { runType } : {}) },
			summary: { avgRps, testDuration: 15 },
		});
		const compare = (reports: Record<string, unknown>) =>
			dispatchTool(
				"compare_runs",
				{ baseRunId: "run_a", targetRunId: "run_b" },
				ctxWith(
					fakeClient({
						getRunReport: vi
							.fn()
							.mockImplementation((id: string) => Promise.resolve(reports[id])),
					})
				)
			);

		test("a load run against a collection run is refused, naming both runs and types", async () => {
			const res = await compare({
				run_a: report("load", 99.88),
				run_b: report("scenario", 340.6),
			});

			expect(res.isError).toBe(true);
			// The refusal's class and nothing of the comparison.
			expect(Object.keys(res.structuredContent ?? {})).toEqual(["error"]);
			const text = firstText(res);
			expect(text).toContain("run_a (Load test)");
			expect(text).toContain("run_b (Collection run)");
			expect(text).toMatch(/list_runs takes a "type" filter/);
			expect(text).not.toContain("avgRps");
			expect(text).not.toContain("340.6");
		});

		test("two collection runs compare", async () => {
			const res = await compare({
				run_a: report("scenario", 10),
				run_b: report("scenario", 12),
			});

			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ comparability: [] });
		});

		test("reports without a run type compare as they always did", async () => {
			const res = await compare({
				run_a: report(undefined, 10),
				run_b: report(undefined, 12),
			});

			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toMatchObject({ comparability: [] });
		});

		test("the description says a mismatched pair is refused", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "compare_runs"));
			expect(description).toMatch(/different types[^.]*refused/);
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

	describe("export_run_report", () => {
		const exportWith = (client: EngineClient, args: Record<string, unknown>) =>
			dispatchTool("export_run_report", { runId: "run_b", ...args }, ctxWith(client));

		const lastOptions = (client: EngineClient) =>
			vi.mocked(client.exportRunReport).mock.calls[0][1];

		test("asks for Markdown, the format an agent reads best, without a series", async () => {
			const client = fakeClient();
			const res = await exportWith(client, {});
			expect(res.isError).toBeFalsy();
			expect(client.exportRunReport).toHaveBeenCalledTimes(1);
			expect(vi.mocked(client.exportRunReport).mock.calls[0][0]).toBe("run_b");
			expect(defaultMcpExportFormat).toBe("markdown");
			expect(lastOptions(client)).toEqual({
				format: "markdown",
				series: "none",
				baseRunId: undefined,
			});
			expect(client.listBaselineRuns).not.toHaveBeenCalled();
		});

		test("passes an explicit base run through without a baseline lookup", async () => {
			const client = fakeClient();
			await exportWith(client, { baseRunId: "run_a", format: "json" });
			expect(lastOptions(client)).toEqual({
				format: "json",
				series: "none",
				baseRunId: "run_a",
			});
			expect(client.listBaselineRuns).not.toHaveBeenCalled();
		});

		test("offers JSON on request, for a program that parses the document", async () => {
			const client = fakeClient();
			await exportWith(client, { format: "json" });
			expect(lastOptions(client)).toMatchObject({ format: "json", series: "none" });
		});

		test("baseline: true compares against the run pinned for the request", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { baseline: true });
			expect(res.isError).toBeFalsy();
			expect(lastOptions(client)).toMatchObject({ baseRunId: "run_pinned" });
		});

		test("baseline: true with nothing pinned says so and exports nothing", async () => {
			const client = fakeClient({
				listBaselineRuns: vi.fn().mockResolvedValue({ data: [] }),
			});
			const res = await exportWith(client, { baseline: true });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/No run is pinned as the baseline/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses a base run and baseline: true together", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { baseRunId: "run_a", baseline: true });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/not both/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses html, naming the Export menu, without asking the engine", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { format: "html" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("Export menu");
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("refuses a format that is neither offered nor html", async () => {
			const client = fakeClient();
			const res = await exportWith(client, { format: "yaml" });
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/"format" must be one of/);
			expect(client.exportRunReport).not.toHaveBeenCalled();
		});

		test("returns the document itself, not the envelope or a JSON-wrapped string", async () => {
			const document = "# Orders\n\n| p99 | 40 ms |\n";
			const client = fakeClient({
				exportRunReport: vi.fn().mockResolvedValue({
					text: document,
					fileName: "Orders.run.md",
					mimeType: "text/markdown",
					notes: {},
				}),
			});
			const res = await exportWith(client, {});
			expect(res.content).toEqual([{ type: "text", text: document }]);
			expect(res.structuredContent).toBeUndefined();
		});

		test("an engine refusal is an error result carrying its sentence", async () => {
			const client = fakeClient({
				exportRunReport: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError(
							"Engine responded 400",
							400,
							'{"error":{"code":"unsupported_run_type"}}'
						)
					),
			});
			const res = await exportWith(client, {});
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain("unsupported_run_type");
		});

		test("an answer with no document text is an error, not an empty result", async () => {
			const client = fakeClient({ exportRunReport: vi.fn().mockResolvedValue({}) });
			const res = await exportWith(client, {});
			expect(res.isError).toBe(true);
		});

		test("points at the tools that hold what the document leaves out", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "export_run_report"));
			expect(description).toContain("get_run_samples");
			expect(description).toContain("get_run_report");
		});
	});
});

/**
 * An agent can refuse a header the engine adds (issue #1337).
 *
 * The engine has taken `disabledDefaultHeaders` on `POST /execute` and
 * `POST /runs` since #1229; what an agent could not do was name it, because the
 * MCP SDK parses arguments through each tool's zod `inputSchema` and a zod
 * object strips what it does not declare. So every case here parses through the
 * tool's own schema first, exactly as the SDK does: handing `dispatchTool` the
 * field directly would pass with the schema entry removed and prove nothing.
 */
describe("default-header opt-outs reach the engine", () => {
	const parseArgs = (name: string, args: Record<string, unknown>) =>
		z
			.object(TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, z.ZodType>)
			.parse(args);

	test("run_request forwards the refused names to /execute", async () => {
		const client = fakeClient();
		const args = parseArgs("run_request", {
			url: "https://api.example.com/users",
			disabledDefaultHeaders: ["User-Agent", "Accept-Encoding"],
		});
		expect(args.disabledDefaultHeaders).toEqual(["User-Agent", "Accept-Encoding"]);

		const res = await dispatchTool(
			"run_request",
			args,
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// The whole point of the argument: this send carries no User-Agent at
		// all, which writing one yourself cannot express.
		expect(payload.disabledDefaultHeaders).toEqual(["User-Agent", "Accept-Encoding"]);
	});

	test("run_request sends no such key when the agent names none", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", { url: "https://api.example.com/users" }),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		// An empty list and no list say the same thing to the engine, so saying
		// it here would be this layer making a claim the agent did not.
		expect(payload).not.toHaveProperty("disabledDefaultHeaders");
	});

	test("a streaming run_request carries them too", async () => {
		// The streaming branch answers `202 {runId, eventsUrl}` and consumes the
		// events itself, so it is the one send whose payload a reader has to
		// follow into a second function - and a refusal dropped there would be a
		// stream opened with a User-Agent the agent declined.
		const client = fakeClient({
			executeRequest: vi
				.fn()
				.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
			consumeStreamEvents: vi
				.fn()
				.mockResolvedValue({ events: [], completed: true, capReached: false }),
		});
		const res = await dispatchTool(
			"run_request",
			parseArgs("run_request", {
				url: "https://api.example.com/events",
				stream: true,
				disabledDefaultHeaders: ["User-Agent"],
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({ stream: true, disabledDefaultHeaders: ["User-Agent"] });
	});

	test("start_load_run forwards the refused names to /runs", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			parseArgs("start_load_run", {
				url: "https://api.example.com",
				confirmed: true,
				disabledDefaultHeaders: ["Accept-Encoding"],
			}),
			ctxWith(client, { allowlist: ["api.example.com"] })
		);

		expect(res.isError).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.disabledDefaultHeaders).toEqual(["Accept-Encoding"]);
	});

	test("run_request carries the whole rule and the other senders point at it", () => {
		const tool = (name: string) => TOOLS.find((t) => t.name === name);
		const description = (name: string) => descriptionOf(tool(name));
		// The one full statement, on the tool that owns the behaviour (#2441). It
		// tells the three senders apart, so the pointers need not.
		expect(description("run_request")).toContain(ENGINE_DEFAULT_HEADERS_SENTENCE);
		expect(ENGINE_DEFAULT_HEADERS_SENTENCE).toMatch(
			/run_request and start_load_run take it as an argument/
		);
		expect(ENGINE_DEFAULT_HEADERS_SENTENCE).toMatch(
			/run_collection_smoke does not: it replays each saved request exactly as stored/
		);
		for (const name of ["start_load_run", "run_collection_smoke"]) {
			expect(description(name), name).not.toContain(ENGINE_DEFAULT_HEADERS_SENTENCE);
			expect(description(name), name).toMatch(/User-Agent.*run_request states the rule/);
		}
		// What the pointer leaves out, each tool's schema still says.
		expect(tool("start_load_run")?.inputSchema).toHaveProperty("disabledDefaultHeaders");
		expect(tool("run_collection_smoke")?.inputSchema).not.toHaveProperty(
			"disabledDefaultHeaders"
		);
		expect(description("run_collection_smoke")).toMatch(
			/no `disabledDefaultHeaders` here: each saved request is replayed exactly as stored/
		);
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
		const shape = tool!.inputSchema as Record<string, z.ZodType>;
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
 * A field the agent leaves out is the engine's default for the mode, and the
 * tool sends it explicitly (#2437): the caps judge the run that will start, the
 * preview and the result say what it is, and the stored run records it.
 */
describe("start_load_run resolves and states the load shape", () => {
	const allowed = { allowlist: ["api.example.com"] };
	const SHAPE_FIELDS = [
		"mode",
		"concurrency",
		"startConcurrency",
		"duration",
		"rampUpDuration",
		"iterations",
		"targetRps",
	];

	const parseArgs = (args: Record<string, unknown>) =>
		z
			.object(
				TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
					string,
					z.ZodType
				>
			)
			.parse(args);

	/** The `POST /runs` payload's load-shape fields, and nothing else. */
	async function sentShape(
		args: Record<string, unknown>,
		safety: Partial<McpSafetyConfig> = allowed,
		client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
		})
	) {
		const res = await dispatchTool(
			"start_load_run",
			{ ...args, confirmed: true },
			ctxWith(client, safety)
		);
		expect(res.isError, firstText(res)).toBeFalsy();
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
			string,
			unknown
		>;
		return Object.fromEntries(
			SHAPE_FIELDS.filter((k) => k in payload).map((k) => [k, payload[k]])
		);
	}

	test("an unconfigured run sends concurrency: 100 and duration: 60s", async () => {
		expect(await sentShape(parseArgs({ url: "https://api.example.com" }))).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			duration: "60s",
		});
	});

	test.each([
		["constant_concurrency", {}, { concurrency: 100, duration: "60s" }],
		["constant_rps", { targetRps: 50 }, { targetRps: 50, duration: "60s" }],
		[
			"ramp_up",
			{},
			{ concurrency: 100, startConcurrency: 1, duration: "60s", rampUpDuration: "10s" },
		],
		["iterations", {}, { iterations: 1000, concurrency: 10 }],
		["capacity", {}, { concurrency: 100, duration: "300s" }],
	])("a %s run sends its row of defaults", async (mode, extra, row) => {
		const sent = await sentShape({ url: "https://api.example.com", mode, ...extra });
		expect(sent).toEqual({ mode, ...row });
	});

	test.each([
		["constant_concurrency", { concurrency: 10, duration: "60s" }],
		[
			"ramp_up",
			{ concurrency: 10, startConcurrency: 1, duration: "60s", rampUpDuration: "10s" },
		],
		["iterations", { iterations: 1000, concurrency: 10 }],
	])("a scenario %s run sends the scenario executor's row", async (mode, row) => {
		const sent = await sentShape({ scenario: { collectionId: "c1" }, mode });
		expect(sent).toEqual({ mode, ...row });
	});

	test("a stated value is never overridden", async () => {
		const ramp = {
			mode: "ramp_up",
			concurrency: 7,
			startConcurrency: 3,
			duration: "45s",
			rampUpDuration: "5s",
		};
		expect(await sentShape({ url: "https://api.example.com", ...ramp })).toEqual(ramp);
		const iterations = { mode: "iterations", iterations: 20, concurrency: 2 };
		expect(await sentShape({ url: "https://api.example.com", ...iterations })).toEqual(
			iterations
		);
	});

	test("a targetRps with no mode is a constant_rps run and sends no concurrency", async () => {
		const sent = await sentShape({ url: "https://api.example.com", targetRps: 100 });
		expect(sent).toEqual({ mode: "constant_rps", targetRps: 100, duration: "60s" });
	});

	test("no mode and no rate stays constant_concurrency, and a zero rate is no rate", async () => {
		expect(await sentShape({ url: "https://api.example.com" })).toMatchObject({
			mode: "constant_concurrency",
		});
		expect(await sentShape({ url: "https://api.example.com", targetRps: 0 })).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			targetRps: 0,
			duration: "60s",
		});
	});

	test("a stated mode is never replaced by the rate, and the engine's refusal reaches the agent", async () => {
		// One rule in one place (#2396): the tool forwards the rate and the engine
		// answers it, rather than a second copy of the rule resolving it away.
		const refusal =
			"'targetRps' selects an open-loop arrival rate and is only available for mode 'constant_rps'; for 'constant_concurrency' set 'concurrency' instead, or send a rate of 0.";
		const client = fakeClient({
			startRun: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						JSON.stringify({ error: refusal })
					)
				),
		});
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com",
				mode: "constant_concurrency",
				targetRps: 100,
				confirmed: true,
			},
			ctxWith(client, allowed)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Engine error (400)");
		expect(firstText(res)).toContain("only available for mode 'constant_rps'");
		const payload = (client.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload).toMatchObject({ mode: "constant_concurrency", targetRps: 100 });
	});

	test("the rate cap judges a rate on any mode, the inferred constant_rps included", async () => {
		const tight = { ...allowed, maxRps: 1000 };
		for (const mode of [undefined, "constant_rps", "constant_concurrency"]) {
			const client = fakeClient();
			const res = await dispatchTool(
				"start_load_run",
				{
					url: "https://api.example.com",
					...(mode ? { mode } : {}),
					targetRps: 5000,
					confirmed: true,
				},
				ctxWith(client, tight)
			);
			expect(res.isError, String(mode)).toBe(true);
			expect(firstText(res), String(mode)).toMatch(
				/targetRps 5000 exceeds the MCP cap of 1000/
			);
			expect(client.startRun).not.toHaveBeenCalled();
		}
	});

	test("the preview states the shape in words and plans the resolved fields", async () => {
		const client = fakeClient();
		const preview = firstText(
			await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com" },
				ctxWith(client, allowed)
			)
		);
		expect(preview).toContain("(constant_concurrency, 100 virtual users, closed loop, 60 s)?");
		expect(preview).toContain('"concurrency": 100');
		expect(preview).toContain('"duration": "60s"');
		expect(client.startRun).not.toHaveBeenCalled();

		const paced = firstText(
			await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com", targetRps: 25, duration: "2m" },
				ctxWith(client, allowed)
			)
		);
		expect(paced).toContain("(constant_rps, 25 requests/s, open loop, 120 s)?");

		// A stated mode keeps its own wording: only constant_rps is open loop.
		const closed = firstText(
			await dispatchTool(
				"start_load_run",
				{
					url: "https://api.example.com",
					mode: "constant_concurrency",
					targetRps: 25,
					duration: "2m",
				},
				ctxWith(client, allowed)
			)
		);
		expect(closed).toContain("(constant_concurrency, 100 virtual users, closed loop, 120 s)?");
		expect(closed).not.toContain("open loop");
	});

	test("the started result carries the shape beside nextStep", async () => {
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", confirmed: true },
			ctxWith(fakeClient(), allowed)
		);
		const structured = res.structuredContent as Record<string, unknown>;
		expect(structured.shape).toEqual({
			mode: "constant_concurrency",
			concurrency: 100,
			duration: "60s",
			closedLoop: true,
		});
		expect(structured.nextStep).toContain("every 6 s");
	});

	test("an omitted concurrency is judged on the default it resolves to", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/concurrency 100 exceeds the MCP cap of 50 virtual users/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("an omitted capacity concurrency is judged on the engine's search ceiling", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com", mode: "capacity", confirmed: true },
			ctxWith(client, { ...allowed, maxConcurrency: 50 })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/concurrency 100 exceeds the MCP cap of 50 virtual users/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("a duration cap under the default is sent in its place", async () => {
		const sent = await sentShape(
			{ url: "https://api.example.com" },
			{
				...allowed,
				maxDurationSeconds: 30,
			}
		);
		expect(sent.duration).toBe("30s");
	});

	test("a misspelt mode is a schema refusal naming the five modes", () => {
		const result = z
			.object(
				TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
					string,
					z.ZodType
				>
			)
			.safeParse({ url: "https://api.example.com", mode: "constant-rps" });
		expect(result.success).toBe(false);
		const message = result.error!.issues.map((issue) => issue.message).join("\n");
		expect(LOAD_MODES).toHaveLength(5);
		for (const mode of LOAD_MODES) expect(message).toContain(`"${mode}"`);
	});

	test("every input with an engine default states it in its description", () => {
		const shape = TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		// Table field -> the input it fills, and how the value is written there.
		const inputs: Record<string, [string, (value: number) => string]> = {
			concurrency: ["concurrency", String],
			startConcurrency: ["startConcurrency", String],
			iterations: ["iterations", String],
			durationSeconds: ["duration", (value) => `${value}s`],
			rampUpDurationSeconds: ["rampUpDuration", (value) => `${value}s`],
		};
		let checked = 0;
		for (const mode of LOAD_MODES) {
			for (const [field, value] of Object.entries(ENGINE_LOAD_DEFAULTS[mode])) {
				if (typeof value !== "number") continue;
				const [input, written] = inputs[field];
				expect(shape[input].description, `${input} for ${mode}`).toMatch(
					new RegExp(`\\b${written(value)} \\([^)]*\\b${mode}\\b`)
				);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(shape.mode.description).toMatch(/default constant_concurrency/);
		expect(shape.mode.description).toMatch(/or constant_rps given `targetRps`/);
		expect(shape.targetRps.description).toMatch(
			/constant_rps only; the engine refuses it on other modes/
		);
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
	async function runRequestFailingWith(err: unknown, host: McpHost = "app") {
		const client = fakeClient({ executeRequest: vi.fn().mockRejectedValue(err) });
		return dispatchTool(
			"run_request",
			{ url: "https://api.example.com/slow" },
			ctxWith(client, { allowlist: ["api.example.com"] }, host)
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

	test("a genuinely unreachable engine says so, naming the app for the app host", async () => {
		const res = await runRequestFailingWith(
			new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876"),
			"app"
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Make sure the Vayu app is running/);
	});

	test("a genuinely unreachable engine says so, naming the process for the CLI host", async () => {
		const res = await runRequestFailingWith(
			new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876"),
			"cli"
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/Start vayu-engine, or point VAYU_ENGINE_URL/);
		expect(firstText(res)).not.toMatch(/Vayu app/);
	});
});

/*
 * A call that timed out or was cancelled may have taken effect, and what to do
 * about that is a fact about the tool (#2777): a create must be looked for in
 * its list before it is repeated, a read can simply be repeated, a send goes
 * through run history.
 */
describe("an interrupted call is told what to check, per tool", () => {
	const TIMEOUT = () => new EngineTimeoutError("POST", "/anything", 35_000);
	const ABORT = () => new DOMException("The operation was aborted.", "AbortError");
	const ALLOWED = { allowWrites: true, allowlist: ["api.example.com"] };

	const createRequestArgs = { collectionId: "c1", name: "Ping", url: "https://api.example.com/" };

	async function interrupted(
		name: string,
		args: Record<string, unknown>,
		method: keyof EngineClient,
		err: unknown
	) {
		const client = fakeClient({ [method]: vi.fn().mockRejectedValue(err) });
		return dispatchTool(name, args, ctxWith(client, ALLOWED));
	}

	describe.each([
		["a timeout", TIMEOUT],
		["a cancelled call", ABORT],
	])("%s", (_label, makeErr) => {
		test("on create_request names list_requests and warns against a blind retry", async () => {
			const res = await interrupted(
				"create_request",
				createRequestArgs,
				"createRequest",
				makeErr()
			);
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/list_requests/);
			expect(firstText(res)).toMatch(/do not retry blindly/);
			expect(firstText(res)).not.toMatch(/list_runs/);
			const advice = (res.structuredContent as { error: { advice: string } }).error.advice;
			expect(advice).toBe(firstText(res));
		});

		test("on import_document names list_collections", async () => {
			const res = await interrupted(
				"import_document",
				{ content: "{}" },
				"importDocument",
				makeErr()
			);
			expect(firstText(res)).toMatch(/list_collections/);
			expect(firstText(res)).not.toMatch(/list_runs/);
		});

		test("on run_request still names list_runs", async () => {
			const res = await interrupted(
				"run_request",
				{ url: "https://api.example.com/slow" },
				"executeRequest",
				makeErr()
			);
			expect(firstText(res)).toMatch(/list_runs/);
		});

		test.each([
			// Declares "safe": a read without the idempotent hint.
			["get_live_metrics", { runId: "run_a" }, "getLiveMetricsSnapshot"],
			// Declares nothing and is annotated idempotent, so it is told "safe".
			["update_engine_config", { entries: {} }, "updateConfig"],
		] as Array<[string, Record<string, unknown>, keyof EngineClient]>)(
			"on %s says repeating it is safe",
			async (name, args, method) => {
				const res = await interrupted(name, args, method, makeErr());
				expect(firstText(res)).toMatch(/Repeating the call is safe/);
				expect(firstText(res)).not.toMatch(/list_runs/);
			}
		);
	});

	test("keeps the timeout's budget and the raise-the-ceiling tail beside the advice", async () => {
		const res = await interrupted(
			"create_request",
			createRequestArgs,
			"createRequest",
			TIMEOUT()
		);
		expect(firstText(res)).toMatch(/35s budget/);
		expect(firstText(res)).toMatch(/update_engine_config/);
	});

	test("a tool that declares no advice gets the generic run-history wording", async () => {
		const bare = {
			...TOOLS.find((t) => t.name === "run_request")!,
			name: "bare",
			retry: undefined,
		};
		TOOLS.push(bare);
		try {
			const res = await interrupted(
				"bare",
				{ url: "https://api.example.com/slow" },
				"executeRequest",
				TIMEOUT()
			);
			expect(firstText(res)).toMatch(/check run history \(list_runs\)/);
		} finally {
			TOOLS.pop();
		}
	});

	test("every tool that is not idempotent declares what to check", () => {
		const scanned = TOOLS.filter((t) => t.annotations.idempotentHint !== true);
		expect(scanned.length).toBeGreaterThan(0);
		const undeclared = scanned.filter((t) => t.retry === undefined).map((t) => t.name);
		expect(undeclared).toEqual([]);
	});

	test("a check names a tool that exists and is a read", () => {
		const checks = TOOLS.flatMap((t) => (typeof t.retry === "object" ? [t.retry.check] : []));
		expect(checks.length).toBeGreaterThan(0);
		for (const check of checks) {
			const tool = TOOLS.find((t) => t.name === check);
			expect(tool, check).toBeDefined();
			expect(tool?.category, check).toBe("read");
		}
	});
});

/*
 * Every error result carries `structuredContent.error` (#2776): the class an
 * agent acts on, whether the same call can succeed again, and the advice, which
 * is the result's own text.
 */
describe("every error result carries a failure class", () => {
	const ALLOWED = { allowlist: ["api.example.com"] };

	/** `run_request` against an allowed host, its send failing with @p err. */
	const sendFailingWith = (err: unknown) =>
		dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(fakeClient({ executeRequest: vi.fn().mockRejectedValue(err) }), ALLOWED)
		);
	const engineAnswered = (status: number, body: string) =>
		sendFailingWith(new EngineRequestError(`Engine responded ${status}`, status, body));

	const cases: Array<[string, string, () => Promise<ToolResult>]> = [
		[
			"a host off the allowlist",
			"policy",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://elsewhere.example.com/" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a load run over the concurrency cap",
			"policy",
			() =>
				dispatchTool(
					"start_load_run",
					{ url: "https://api.example.com/", concurrency: 100_000, duration: "10s" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a load run whose duration is not one",
			"input",
			() =>
				dispatchTool(
					"start_load_run",
					{ url: "https://api.example.com/", concurrency: 1, duration: "forever" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"a write while writes are off",
			"policy",
			() => dispatchTool("create_collection", { name: "API" }, ctxWith(fakeClient())),
		],
		[
			"a tool switched off in Settings",
			"policy",
			() =>
				dispatchTool(
					"get_engine_health",
					{},
					ctxWith(fakeClient(), { disabledTools: ["get_engine_health"] })
				),
		],
		[
			// The stdio CLI never has a window, so calling again cannot help.
			"no Vayu window to ask",
			"policy",
			() => dispatchTool("get_app_focus", {}, ctxWith(fakeClient())),
		],
		[
			"a file body sent inline",
			"policy",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://api.example.com/", bodyType: "binary" },
					ctxWith(fakeClient(), ALLOWED)
				),
		],
		[
			"an engine target-policy refusal",
			"policy",
			() =>
				engineAnswered(
					400,
					engineErrorBody("target_not_allowed", 'Host "evil.example.com" is not allowed.')
				),
		],
		["an engine 403", "policy", () => engineAnswered(403, "forbidden")],
		["an engine 400", "input", () => engineAnswered(400, "bad request")],
		["an engine 409", "input", () => engineAnswered(409, "already exists")],
		["an engine 413", "input", () => engineAnswered(413, "too large")],
		[
			"a missing required argument",
			"input",
			() => dispatchTool("get_run", {}, ctxWith(fakeClient())),
		],
		["an unknown tool", "input", () => dispatchTool("no_such_tool", {}, ctxWith(fakeClient()))],
		["an engine 404", "not_found", () => engineAnswered(404, "not found")],
		[
			"a run id the engine does not hold",
			"not_found",
			() =>
				dispatchTool(
					"get_run",
					{ runId: "run_gone" },
					ctxWith(
						fakeClient({
							getRun: vi
								.fn()
								.mockRejectedValue(
									new EngineRequestError("Engine responded 404", 404, "")
								),
						})
					)
				),
		],
		[
			"a saved request id compose does not hold",
			"not_found",
			() =>
				dispatchTool(
					"run_request",
					{ requestId: "req_gone" },
					ctxWith(
						fakeClient({
							composeRequest: vi
								.fn()
								.mockRejectedValue(
									new EngineRequestError("Engine responded 404", 404, "")
								),
						}),
						ALLOWED
					)
				),
		],
		[
			"a client-budget timeout",
			"transient",
			() => sendFailingWith(new EngineTimeoutError("POST", "/execute", 130_000)),
		],
		[
			"a cancelled call",
			"transient",
			() => sendFailingWith(new DOMException("The operation was aborted.", "AbortError")),
		],
		["an engine 500", "transient", () => engineAnswered(500, "boom")],
		["an engine 507", "transient", () => engineAnswered(507, "disk full")],
		[
			"a busy database",
			"transient",
			() => engineAnswered(503, engineErrorBody("unavailable", "The database is busy")),
		],
		[
			"an unclassified transport error",
			"transient",
			() => sendFailingWith(new Error("socket hang up")),
		],
		[
			"a handler that threw",
			"transient",
			() =>
				dispatchTool(
					"get_app_focus",
					{},
					{
						...ctxWith(fakeClient()),
						appFocus: () => {
							throw new Error("window gone mid-read");
						},
					}
				),
		],
		[
			"a masking lookup that failed",
			"transient",
			() =>
				dispatchTool(
					"run_request",
					{ url: "https://api.example.com/" },
					ctxWith(
						fakeClient({
							executeRequest: vi
								.fn()
								.mockResolvedValue({ status: 200, bodyRaw: "ok" }),
							getGlobals: vi
								.fn()
								.mockRejectedValue(new Error("Engine responded 500")),
						}),
						ALLOWED
					)
				),
		],
		[
			"an engine that refused the connection",
			"unreachable",
			() =>
				sendFailingWith(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9876")),
		],
		[
			"an engine shutting down",
			"unreachable",
			() => engineAnswered(503, engineErrorBody("unavailable", "Engine is shutting down")),
		],
	];

	const RETRYABLE = new Set(["transient", "unreachable"]);

	test.each(cases)("%s is %s", async (_, failureClass, call) => {
		const res = await call();
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			error: {
				class: failureClass,
				retryable: RETRYABLE.has(failureClass),
				advice: firstText(res),
			},
		});
	});

	test("the advice is the remedy-resolved text, not the token", async () => {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/", bodyType: "binary" },
			ctxWith(fakeClient(), ALLOWED, "cli")
		);
		const error = (res.structuredContent as { error: { advice: string } }).error;
		expect(error.advice).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "cli"));
		expect(error.advice).not.toMatch(/\{\{remedy:/);
	});

	test("a caveat appended to an error keeps the error's class", async () => {
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/", requestId: "req_1" },
			ctxWith(
				fakeClient({
					executeRequest: vi
						.fn()
						.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED")),
				}),
				ALLOWED
			)
		);
		expect(res.content.length).toBe(2);
		expect(res.structuredContent).toMatchObject({ error: { class: "unreachable" } });
	});

	test("a success carries no failure", async () => {
		const res = await dispatchTool("get_engine_health", {}, ctxWith(fakeClient()));
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).not.toHaveProperty("error");
	});

	/*
	 * `errorResult` is what records the class, so an error result assembled by
	 * hand would reach dispatch unclassed and be answered with a guess. The one
	 * other builder is dispatch's own answer, made from the recorded class.
	 */
	test("no source builds an error result except errorResult and dispatch", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
			(file) =>
				file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testkit")
		);
		const builders = sources.filter((file) =>
			/isError:\s*true/.test(readFileSync(path.join(here, file), "utf8"))
		);
		// A scan that found neither read nothing.
		expect(builders.sort()).toEqual(["tools.ts", path.join("tools", "kit.ts")]);
	});
});

/*
 * An id the engine does not hold reads as the missing object and the tool that
 * lists them, never as the engine's JSON or the HTTP path it was asked for
 * (#2778).
 */
describe("an unknown id names the object and its list tool", () => {
	const notFoundBody = (noun: string) => engineErrorBody("not_found", `${noun} not found`);
	const engine404 = (body: string, path = "/runs/run_x/report") =>
		new EngineRequestError(`Engine responded 404 for GET ${path}`, 404, body);

	describe("get_live_metrics 404", () => {
		const LIVE_EXPIRED =
			"The live buffer for this run expired (kept 60 s after it ends); the run still exists - read get_run_report(runId).";
		const liveExpiredBody = JSON.stringify({
			error: "Live metrics for this run are no longer retained",
			code: "live_expired",
			hint: "Use /runs/run_x/report for the stored report",
		});
		const liveCall = async (body: string) =>
			dispatchTool(
				"get_live_metrics",
				{ runId: "run_x" },
				ctxWith(
					fakeClient({
						getLiveMetricsSnapshot: vi
							.fn()
							.mockRejectedValue(engine404(body, "/runs/run_x/live")),
					})
				)
			);

		test("live_expired says the buffer expired and the run still exists, in the not_found class", async () => {
			const res = await liveCall(liveExpiredBody);
			expect(res.isError).toBe(true);
			const text = firstText(res);
			expect(text).toBe(LIVE_EXPIRED);
			expect(text).not.toContain("/runs/");
			expect(text).not.toContain("No run with id");
			expect(res.structuredContent).toEqual({
				error: { class: "not_found", retryable: false, advice: LIVE_EXPIRED },
			});
		});

		test("live_expired is read from the nested error shape too", async () => {
			const res = await liveCall(engineErrorBody("live_expired", "Live metrics are gone"));
			expect(firstText(res)).toBe(LIVE_EXPIRED);
		});

		test("run_not_found keeps the unknown-id text, with no hint path", async () => {
			const res = await liveCall(
				JSON.stringify({
					error: "Run not found or expired",
					code: "run_not_found",
					hint: "Use /runs/run_x/report for the stored report",
				})
			);
			expect(firstText(res)).toBe(
				'No run with id "run_x" (it may have been deleted or the id is mistyped). ' +
					"List runs with list_runs."
			);
			expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
		});

		test("a 404 with no code falls back to the engine's words", async () => {
			const res = await liveCall(
				JSON.stringify({ error: "Live metrics for this run are no longer retained" })
			);
			const text = firstText(res);
			expect(text).not.toBe(LIVE_EXPIRED);
			expect(text).toBe(
				'Engine error (404): {"error":"Live metrics for this run are no longer retained"}'
			);
			expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
		});

		test("the sentence is the tool's own: another tool's live_expired is not reworded", async () => {
			const client = fakeClient({
				getRunReport: vi.fn().mockRejectedValue(engine404(liveExpiredBody)),
			});
			const res = await dispatchTool("get_run_report", { runId: "run_x" }, ctxWith(client));
			expect(firstText(res)).not.toBe(LIVE_EXPIRED);
		});

		test("the description names the retention window", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_live_metrics"));
			expect(description).toContain("60 s");
			expect(description).toContain("get_run_report");
		});
	});

	describe("engineCode", () => {
		test.each([
			["flat", '{"error":"x","code":"live_expired"}', "live_expired"],
			["nested", '{"error":{"code":"not_found","message":"x"}}', "not_found"],
			["absent", '{"error":"x"}', undefined],
			["empty", '{"error":"x","code":""}', undefined],
			["not JSON", "plain text", undefined],
			["JSON null", "null", undefined],
		])("%s body", (_shape, body, expected) => {
			expect(engineCode(body)).toBe(expected);
		});
	});

	test("a 404 on get_run_report names the run and list_runs, with no path and no JSON", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run"))),
		});
		const res = await dispatchTool("get_run_report", { runId: "run_x" }, ctxWith(client));
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toBe(
			'No run with id "run_x" (it may have been deleted or the id is mistyped). ' +
				"List runs with list_runs."
		);
		expect(text).not.toContain("/runs/");
		expect(text).not.toContain("{");
		expect(res.structuredContent).toEqual({
			error: { class: "not_found", retryable: false, advice: text },
		});
	});

	test.each([
		["request", "Request not found", 'No request with id "req_1"'],
		["example", "Example not found", 'No example with id "ex_1"'],
	])(
		"a tool taking two ids names the %s the engine's sentence says is missing",
		async (_kind, sentence, expected) => {
			const client = fakeClient({
				updateRequestExample: vi.fn().mockRejectedValue(engine404(notFoundBody(sentence))),
			});
			const res = await dispatchTool(
				"update_request_example",
				{ requestId: "req_1", exampleId: "ex_1", name: "renamed" },
				ctxWith(client, { allowWrites: true })
			);
			expect(firstText(res)).toContain(expected);
		}
	);

	test("two ids of one kind with nothing to say which, name neither", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run"))),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(firstText(res)).toMatch(/^No run matches the id given \(/);
		expect(firstText(res)).not.toContain("run_a");
		expect(firstText(res)).not.toContain("run_b");
	});

	test("two ids of one kind name the one the engine's sentence carries", async () => {
		const client = fakeClient({
			getRunReport: vi.fn().mockRejectedValue(engine404(notFoundBody("Run run_b"))),
		});
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_a", targetRunId: "run_b" },
			ctxWith(client)
		);
		expect(firstText(res)).toMatch(/^No run with id "run_b" \(/);
	});

	test("a spec has no list tool, so the sentence stops at the cause", async () => {
		const client = fakeClient({
			getSpecMeta: vi
				.fn()
				.mockRejectedValue(engine404(notFoundBody("Spec"), "/specs/s/meta")),
		});
		const res = await dispatchTool("get_spec", { specId: "spec_1" }, ctxWith(client));
		expect(firstText(res)).toBe(
			'No spec with id "spec_1" (it may have been deleted or the id is mistyped).'
		);
	});

	test("a 404 the declared noun does not describe stays the engine's compact sentence", async () => {
		const client = fakeClient({
			getRun: vi.fn().mockRejectedValue(engine404(engineErrorBody("not_found", "Gone"))),
		});
		const res = await dispatchTool("get_run", { runId: "run_x" }, ctxWith(client));
		expect(firstText(res)).toBe(
			'Engine error (404): {"error":{"code":"not_found","message":"Gone"}}'
		);
	});

	test("a tool that declares nothing keeps a one-line engine error for a 404", async () => {
		const pretty = JSON.stringify({ error: { code: "not_found", message: "Gone" } }, null, 2);
		const client = fakeClient({ listRuns: vi.fn().mockRejectedValue(engine404(pretty)) });
		const res = await dispatchTool("list_runs", { requestId: "req_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(
			'Engine error (404): {"error":{"code":"not_found","message":"Gone"}}'
		);
		expect(res.structuredContent).toMatchObject({ error: { class: "not_found" } });
	});

	test("engine bodies formatted differently come out on one line", async () => {
		const bodies = [
			JSON.stringify({ error: { code: "bad_request", message: "no good" } }, null, 2),
			JSON.stringify({ error: { code: "bad_request", message: "no good" } }),
			"no good\n  at\tsome\n  place",
		];
		const texts: string[] = [];
		for (const body of bodies) {
			const client = fakeClient({
				listRuns: vi.fn().mockRejectedValue(new EngineRequestError("400", 400, body)),
			});
			texts.push(firstText(await dispatchTool("list_runs", {}, ctxWith(client))));
		}
		for (const text of texts) expect(text).not.toMatch(/\n/);
		expect(texts[0]).toBe(texts[1]);
		expect(texts[2]).toBe("Engine error (400): no good at some place");
	});

	test("the retry hint still follows a compacted body", async () => {
		const body = JSON.stringify(
			{ error: { code: "insufficient_storage", message: "full" } },
			null,
			2
		);
		const client = fakeClient({
			listRuns: vi.fn().mockRejectedValue(new EngineRequestError("507", 507, body)),
		});
		const res = await dispatchTool("list_runs", {}, ctxWith(client));
		expect(firstText(res)).toBe(
			'Engine error (507): {"error":{"code":"insufficient_storage","message":"full"}} ' +
				"Retry the call after space is freed."
		);
	});

	/*
	 * A tool with a `<kind>Id` argument either declares what the id names or
	 * says here why an unknown one cannot be worded by the 404 layer.
	 */
	const EXEMPT: Readonly<Record<string, string>> = {
		list_requests: "filters a list: an unknown collection lists nothing, it is not a 404",
		list_runs: "filters a list: an unknown request or collection lists nothing",
		get_graphql_schema: "composes the send; composeViaEngine and selectEnvironment word the id",
		run_request: "composes the send; composeViaEngine and selectEnvironment word the id",
		run_collection_smoke:
			"composes each send; composeViaEngine and selectEnvironment word the id",
		start_load_run: "composes the send; composeViaEngine and selectEnvironment word the id",
		resolve_variables: "gatherVariableScopes and selectEnvironment word the id",
		create_collection: "the engine does not check that parentId exists",
		create_request: "an unknown collectionId is a 400 that names it, not a 404",
		move_item: "reads the collection list first and words an unknown id itself (move.tools.ts)",
		clear_cookies:
			"environmentId names a jar, which need not exist; clearing an empty one is 0",
	};
	const idKeys = (tool: (typeof TOOLS)[number]) =>
		Object.keys(tool.inputSchema).filter((key) => /[a-z]Id$/.test(key));
	const scanned = TOOLS.filter((tool) => idKeys(tool).length > 0);

	test("every tool with a <kind>Id argument declares notFound or is exempt with a reason", () => {
		expect(scanned.length).toBeGreaterThan(0);
		const unaccounted = scanned
			.filter((tool) => tool.notFound === undefined && !(tool.name in EXEMPT))
			.map((tool) => tool.name);
		expect(unaccounted).toEqual([]);
	});

	test("an exemption is for a tool that exists, has an id, and declares nothing", () => {
		for (const name of Object.keys(EXEMPT)) {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(idKeys(tool!), name).not.toEqual([]);
			expect(tool!.notFound, name).toBeUndefined();
		}
	});

	test("a declaration names arguments the tool takes and a list tool that is a read", () => {
		const declared = scanned.flatMap((tool) =>
			tool.notFound === undefined ? [] : [{ tool, notFound: tool.notFound }]
		);
		expect(declared.length).toBeGreaterThan(0);
		for (const { tool, notFound } of declared) {
			const entries = "idArg" in notFound ? [notFound] : notFound;
			for (const entry of entries) {
				const args = typeof entry.idArg === "string" ? [entry.idArg] : entry.idArg;
				for (const arg of args)
					expect(tool.inputSchema, `${tool.name}.${arg}`).toHaveProperty(arg);
				if (entry.list === undefined) continue;
				const list = TOOLS.find((t) => t.name === entry.list);
				expect(list, `${tool.name} -> ${entry.list}`).toBeDefined();
				expect(list?.category).toBe("read");
				expect(entry.list).toMatch(/^list_/);
			}
		}
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
		expect(firstText(res)).toContain('No mock issuer with id "issuer_9"');
		expect(firstText(res)).toContain("list_mock_issuers");
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
			z.ZodType
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
		expect(firstText(res)).toContain('No mock issuer with id "issuer_9"');
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
			expect(firstText(res), tool).toMatch(/is disabled\..*Vayu Settings → MCP/);
		}
		expect(client.startMockIssuer).not.toHaveBeenCalled();
		expect(client.listMockIssuers).not.toHaveBeenCalled();
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
		expect(client.stopMockIssuer).not.toHaveBeenCalled();
	});

	test("the schema refuses a malformed config before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_issuer")!.inputSchema as Record<
			string,
			z.ZodType
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

	test("start and stop are execute, the reads are read, and none opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_server")?.category).toBe("execute");
		expect(tools.get("stop_mock_server")?.category).toBe("execute");
		expect(tools.get("list_mock_servers")?.category).toBe("read");
		expect(tools.get("get_mock_routes")?.category).toBe("read");
		expect(tools.get("get_mock_activity")?.category).toBe("read");
		for (const name of [
			"start_mock_server",
			"stop_mock_server",
			"list_mock_servers",
			"get_mock_routes",
			"get_mock_activity",
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
		expect(byName().get("get_mock_activity")?.invalidates).toEqual([]);
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
		// Absent means the engine's any-origin default; a `[]` the caller never
		// wrote would be a policy statement they did not make.
		expect(Object.keys(payload as object)).not.toContain("allowedOrigins");
		const body = JSON.parse(firstText(res)) as Record<string, unknown>;
		expect(body.mockId).toBe("mock_1");
		expect(body.url).toBe("http://127.0.0.1:45010");
		expect(body.routeCount).toBe(4);
	});

	test("start forwards every knob under the engine's own names", async () => {
		const client = fakeClient();
		const args = {
			collectionId: "col_1",
			port: 45010,
			latencyMs: 100,
			errorRatePct: 25,
			allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
		};
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

	test("activity defaults its limit to 50 and forwards an explicit one", async () => {
		const client = fakeClient();
		const defaulted = await dispatchTool(
			"get_mock_activity",
			{ mockId: "mock_1" },
			ctxWith(client)
		);
		expect(defaulted.isError).toBeFalsy();
		expect(client.getMockServerActivity).toHaveBeenCalledWith("mock_1", 50, undefined);

		const limited = await dispatchTool(
			"get_mock_activity",
			{ mockId: "mock_1", limit: 10 },
			ctxWith(client)
		);
		expect(limited.isError).toBeFalsy();
		expect(client.getMockServerActivity).toHaveBeenCalledWith("mock_1", 10, undefined);
	});

	test("activity surfaces an unknown mock id as a tool error", async () => {
		const gone = fakeClient({
			getMockServerActivity: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Mock server not found")
				),
		});
		const res = await dispatchTool("get_mock_activity", { mockId: "mock_9" }, ctxWith(gone));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No mock server with id "mock_9"');
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
		expect(firstText(res)).toContain('No mock server with id "mock_9"');
		expect(firstText(res)).toContain("list_mock_servers");
	});

	test("the schema refuses a malformed knob before the engine sees it", () => {
		const shape = TOOLS.find((t) => t.name === "start_mock_server")!.inputSchema as Record<
			string,
			z.ZodType
		>;
		expect(shape.port.safeParse(70000).success).toBe(false);
		expect(shape.port.safeParse(0).success).toBe(true);
		// A percentage is 0-100 by definition rather than by an engine constant,
		// which is why this bound lives here and `latencyMs`'s ceiling does not.
		expect(shape.errorRatePct.safeParse(101).success).toBe(false);
		expect(shape.errorRatePct.safeParse(100).success).toBe(true);
		expect(shape.latencyMs.safeParse(-1).success).toBe(false);
		// The origin list's shape is the schema's; what makes an entry an origin,
		// and how many may be listed, is the engine's to refuse by name.
		expect(shape.allowedOrigins.safeParse(["https://app.example.com"]).success).toBe(true);
		expect(shape.allowedOrigins.safeParse([]).success).toBe(true);
		expect(shape.allowedOrigins.safeParse("https://app.example.com").success).toBe(false);
		expect(shape.allowedOrigins.safeParse([42]).success).toBe(false);
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
			["get_mock_activity", { mockId: "mock_1" }],
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
				"get_mock_activity",
				"stop_mock_server",
			],
		});
		for (const [tool, args] of [
			["start_mock_server", { collectionId: "col_1" }],
			["list_mock_servers", {}],
			["get_mock_routes", { mockId: "mock_1" }],
			["get_mock_activity", { mockId: "mock_1" }],
			["stop_mock_server", { mockId: "mock_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/is disabled\..*Vayu Settings → MCP/);
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

		// #2445: the bound used to ride as a second text block, so page one of
		// 17 runs stopped parsing as JSON exactly when there was a page two.
		test("a page with more behind it is one JSON document carrying the next offset", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1" }], 17)),
			});
			const res = await dispatchTool("list_runs", { limit: 1 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.hasMore).toBe(true);
			expect(pagination.nextOffset).toBe(1);
			expect(pagination.note).toMatch(/1 of 17 runs, starting at offset 0/);
		});

		// #2820: a guard on the pass-through. The handler adds no shaping that
		// touches resultSummary, so no mutation of today's code reddens it; it
		// fails if row shaping ever starts allow-listing the summary's keys.
		test("a scenario load row's assertion counts reach the agent beside errorRate", async () => {
			const resultSummary = {
				rps: 485,
				p95Ms: 42,
				errorRate: 0,
				assertionsPassed: 10,
				assertionsFailed: 4580,
			};
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_1", resultSummary }])),
			});
			const res = await dispatchTool("list_runs", {}, ctxWith(client));
			const rows = (JSON.parse(firstText(res)) as { data: Array<Record<string, unknown>> })
				.data;
			expect(rows[0].resultSummary).toEqual(resultSummary);
		});

		test("the last page has a null next offset and no note", async () => {
			const client = fakeClient({
				listRuns: vi.fn().mockResolvedValue(page([{ id: "run_17" }], 17, 16)),
			});
			const res = await dispatchTool("list_runs", { limit: 1, offset: 16 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.hasMore).toBe(false);
			expect(pagination.nextOffset).toBeNull();
			expect(pagination).not.toHaveProperty("note");
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
			expect(firstText(res)).toContain('No run with id "gone"');
		});
	});

	describe("every paged read answers one JSON document its outputSchema accepts", () => {
		const PAGED_READS = [
			{ tool: "list_runs", args: {}, method: "listRuns", row: { id: "run_1" } },
			{
				tool: "get_run_samples",
				args: { runId: "run_1" },
				method: "getRunSamples",
				row: { resultId: 1 },
			},
			{
				tool: "get_run_timeseries",
				args: { runId: "run_1" },
				method: "getRunTimeSeries",
				row: { rps: 10 },
			},
			{
				tool: "get_run_monitor",
				args: { runId: "run_1" },
				method: "getRunMonitorSeries",
				row: { cpu: 0.5 },
			},
			{
				tool: "get_inbox_captures",
				args: { inboxId: "inbox_1" },
				method: "getInboxCaptures",
				row: { id: 9 },
			},
			{
				tool: "list_collections",
				args: {},
				method: "listCollectionsPage",
				row: { id: "col_1", name: "API", parentId: null },
			},
			{
				tool: "list_requests",
				args: { collectionId: "col_1" },
				method: "listRequestsPage",
				row: { id: "req_1", name: "Get", method: "GET", url: "https://a.test" },
			},
			{
				tool: "get_cookies",
				args: {},
				method: "getCookiesPage",
				row: { environmentId: null, name: "sid", domain: "a.test" },
			},
			{
				tool: "list_trash",
				args: {},
				method: "listTrashPage",
				row: { id: "col_9", kind: "collection" },
			},
		] as const;

		/** @p tool's declared outputSchema; its absence fails the case rather than skipping it. */
		function outputSchemaOf(tool: string) {
			const schema = TOOLS.find((t) => t.name === tool)?.outputSchema;
			expect(schema, tool).toBeDefined();
			return schema!;
		}

		test.each(PAGED_READS)(
			"$tool: a page with more behind it",
			async ({ tool, args, method, row }) => {
				const client = fakeClient({ [method]: vi.fn().mockResolvedValue(page([row], 17)) });
				const res = await dispatchTool(tool, { ...args, limit: 1 }, ctxWith(client));
				expect(res.content).toHaveLength(1);
				const pagination = pageOf(res);
				expect(pagination.hasMore).toBe(true);
				expect(pagination.nextOffset).toBe(1);
				expect(pagination.note).toEqual(expect.any(String));
				expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
			}
		);

		test.each(PAGED_READS)("$tool: the last page", async ({ tool, args, method, row }) => {
			const client = fakeClient({ [method]: vi.fn().mockResolvedValue(page([row], 17, 16)) });
			const res = await dispatchTool(tool, { ...args, offset: 16 }, ctxWith(client));
			expect(res.content).toHaveLength(1);
			const pagination = pageOf(res);
			expect(pagination.nextOffset).toBeNull();
			expect(pagination).not.toHaveProperty("note");
			expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
		});

		// The schema would reject a bare non-object, and the SDK reports that as
		// a broken tool while hiding the engine's body.
		test.each(PAGED_READS)(
			"$tool: a non-object answer is wrapped, not refused",
			async ({ tool, args, method }) => {
				const client = fakeClient({ [method]: vi.fn().mockResolvedValue(null) });
				const res = await dispatchTool(tool, args, ctxWith(client));
				expect(res.isError).toBeFalsy();
				expect(res.structuredContent).toEqual({ raw: null });
				expect(() => outputSchemaOf(tool).parse(res.structuredContent)).not.toThrow();
			}
		);
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

		describe("a credential typed into the run's url (#1909)", () => {
			const runWith = (url: string) =>
				vi.fn().mockResolvedValue({
					id: "run_b",
					type: "load",
					status: "completed",
					startTime: 1_755_000_000_000,
					configSnapshot: { url },
				});

			test("is masked in the preview by its name, with the rest of the url kept", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY&page=2"),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b" },
					ctxWith(client, { allowWrites: true })
				);
				expect(firstText(res)).not.toContain("LITERAL-KEY");
				expect(firstText(res)).toContain("api_key=<redacted>&page=2");
				expect(client.deleteRun).not.toHaveBeenCalled();
			});

			test("is shown as written with reveal on, and no secret is read to know it", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY&page=2"),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b" },
					ctxWith(client, { allowWrites: true, revealSecretsToAgents: true })
				);
				expect(firstText(res)).toContain("api_key=LITERAL-KEY&page=2");
				expect(client.getGlobals).not.toHaveBeenCalled();
			});

			test("withholds the whole call when the masking cannot be built, deleting nothing", async () => {
				const client = fakeClient({
					getRun: runWith("https://api.example.com/users?api_key=LITERAL-KEY"),
					getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
				});
				const res = await dispatchTool(
					"delete_run",
					{ runId: "run_b", confirmed: true },
					ctxWith(client, { allowWrites: true })
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).not.toContain("LITERAL-KEY");
				expect(client.deleteRun).not.toHaveBeenCalled();
			});
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

describe("run status reads (#2436)", () => {
	const NOW = 1_755_000_100_000;
	const START = 1_755_000_000_000;

	function runRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "run_1",
			type: "load",
			status: "running",
			startTime: START,
			// What the engine writes for a row that has not finished.
			endTime: START,
			configSnapshot: {
				url: "https://api.example.com/users",
				mode: "constant_rps",
				duration: "200s",
				concurrency: 10,
				targetRps: 50,
			},
			requestId: "req_1",
			baseline: false,
			...overrides,
		};
	}

	async function getRun(row: unknown) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		try {
			const client = fakeClient({ getRun: vi.fn().mockResolvedValue(row) });
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			return JSON.parse(firstText(res)) as Record<string, unknown>;
		} finally {
			vi.useRealTimers();
		}
	}

	describe("get_run", () => {
		test.each(["pending", "running"])(
			"a %s run is not terminal and has no end",
			async (status) => {
				const out = await getRun(runRow({ status }));
				expect(out).toMatchObject({
					id: "run_1",
					type: "load",
					status,
					terminal: false,
					startTime: START,
					endTime: null,
					elapsedMs: NOW - START,
					mode: "constant_rps",
					concurrency: 10,
					targetRps: 50,
					duration: "200s",
					requestId: "req_1",
					baseline: false,
				});
				// 200 s planned: a tenth is 20 s, held to the 10 s ceiling.
				expect(out.nextStep).toBe("still running; read again in 10 s, or stop_run");
			}
		);

		test.each(["completed", "failed", "stopped"])(
			"a %s run is terminal and reports its real end",
			async (status) => {
				const out = await getRun(runRow({ status, endTime: START + 60_000 }));
				expect(out.terminal).toBe(true);
				expect(out.endTime).toBe(START + 60_000);
				expect(out.elapsedMs).toBe(60_000);
			}
		);

		test("each terminal status points at the report, and a stopped run says it has no verdict", async () => {
			const done = await getRun(runRow({ status: "completed", endTime: START + 1 }));
			expect(done.nextStep).toBe("read get_run_report(runId)");
			const failed = await getRun(runRow({ status: "failed", endTime: START + 1 }));
			expect(failed.nextStep).toMatch(/what was recorded before the failure/);
			// A failed run's counts may be absent altogether (#2895): the pointer names the flags.
			expect(failed.nextStep).toMatch(/summary\.summaryMissing or summary\.partial/);
			const stopped = await getRun(runRow({ status: "stopped", endTime: START + 1 }));
			expect(stopped.nextStep).toMatch(/partial numbers.*no verdict/);
		});

		test("a running row whose endTime is non-zero is still not terminal", async () => {
			// endTime is seeded to startTime, so `> 0` would call every run done.
			const out = await getRun(runRow({ status: "running", endTime: START }));
			expect(out.terminal).toBe(false);
			expect(out.endTime).toBeNull();
		});

		test("a duration-bound run reports its progress, clamped to 0..1", async () => {
			const half = await getRun(runRow());
			expect(half.plannedDurationMs).toBe(200_000);
			expect(half.progress).toBe(0.5);

			const overrun = await getRun(
				runRow({ configSnapshot: { mode: "constant_rps", duration: "10s" } })
			);
			expect(overrun.progress).toBe(1);

			const notStarted = await getRun(runRow({ startTime: NOW + 5_000 }));
			expect(notStarted.progress).toBe(0);
		});

		test("an iterations run, or a duration that does not parse, has no progress and the 5 s poll", async () => {
			const iterations = await getRun(
				runRow({ configSnapshot: { mode: "iterations", duration: "30s", iterations: 100 } })
			);
			expect(iterations.plannedDurationMs).toBeNull();
			expect(iterations.progress).toBeNull();
			expect(iterations.nextStep).toBe("still running; read again in 5 s, or stop_run");

			const unparsed = await getRun(
				runRow({ configSnapshot: { mode: "constant_rps", duration: "soon" } })
			);
			expect(unparsed.plannedDurationMs).toBeNull();
			expect(unparsed.progress).toBeNull();
			expect(unparsed.nextStep).toContain("5 s");

			const design = await getRun(runRow({ type: "design", configSnapshot: { url: "u" } }));
			expect(design.progress).toBeNull();
			expect(design.duration).toBeNull();
		});

		test("the poll interval is a tenth of the duration between 2 and 10 s", async () => {
			const poll = async (duration: string) =>
				(await getRun(runRow({ configSnapshot: { mode: "constant_rps", duration } })))
					.nextStep;
			expect(await poll("5s")).toContain("in 2 s");
			expect(await poll("45s")).toContain("in 5 s");
			expect(await poll("60s")).toContain("in 6 s");
			expect(await poll("5m")).toContain("in 10 s");
		});

		test("the projection never carries the trace, the result or the rest of the snapshot", async () => {
			const out = await getRun(
				runRow({
					configSnapshot: {
						url: "https://api.example.com/users",
						mode: "constant_rps",
						duration: "30s",
						headers: { "X-Tenant": "acme" },
						comment: "nightly",
					},
					result: { statusCode: 200 },
					trace: { response: { body: "<body>" } },
					designResult: { trace: { response: { body: "<body>" } } },
				})
			);
			expect(Object.keys(out).sort()).toEqual(
				[
					"id",
					"type",
					"status",
					"terminal",
					"startTime",
					"endTime",
					"elapsedMs",
					"plannedDurationMs",
					"progress",
					"mode",
					"concurrency",
					"targetRps",
					"duration",
					"requestId",
					"baseline",
					"nextStep",
				].sort()
			);
			expect(JSON.stringify(out)).not.toMatch(/api\.example\.com|acme|nightly|<body>/);
		});

		test("an id that names no run is an error naming the id", async () => {
			const client = fakeClient({
				getRun: vi
					.fn()
					.mockRejectedValue(new EngineRequestError("404", 404, "Run not found")),
			});
			const res = await dispatchTool("get_run", { runId: "run_missing" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toContain('No run with id "run_missing"');
		});

		test("any other engine failure is reported as the engine's", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("500", 500, "boom")),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe("Engine error (500): boom");
		});

		test("a full disk is reported as retryable once space is freed (#2423)", async () => {
			const body = engineErrorBody(
				"insufficient_storage",
				"The disk holding Vayu's data is full - free up space and try again"
			);
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("507", 507, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(
				`Engine error (507): ${body} Retry the call after space is freed.`
			);
		});

		test("a busy database is reported as retryable (#2423)", async () => {
			const body = engineErrorBody(
				"unavailable",
				"The Vayu database is busy - try again in a moment"
			);
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("503", 503, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toBe(`Engine error (503): ${body} Retry the call in a moment.`);
		});

		test("a 503 from a shutting-down engine carries no retry hint (#2423)", async () => {
			const body = engineErrorBody("unavailable", "Engine is shutting down");
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("503", 503, body)),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(firstText(res)).toBe(`Engine error (503): ${body}`);
		});

		test("an ordinary engine failure carries no retry hint", async () => {
			const client = fakeClient({
				getRun: vi.fn().mockRejectedValue(new EngineRequestError("400", 400, "bad")),
			});
			const res = await dispatchTool("get_run", { runId: "run_1" }, ctxWith(client));
			expect(firstText(res)).toBe("Engine error (400): bad");
		});

		test("requires a runId", async () => {
			const res = await dispatchTool("get_run", {}, ctxWith(fakeClient()));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/runId/);
		});

		test("is a read tool and states what it withholds from run output", () => {
			const tool = TOOLS.find((t) => t.name === "get_run");
			expect(tool?.category).toBe("read");
			expect(tool?.annotations.readOnlyHint).toBe(true);
			expect(descriptionOf(tool)).toContain(
				withheldPointer({ revealSecretsToAgents: false }, "recorded")
			);
		});
	});

	describe("get_run_report", () => {
		const report = (status: string, extra: Record<string, unknown> = {}) => ({
			metadata: { runId: "run_1", status },
			summary: { totalRequests: 0 },
			...extra,
		});

		async function readReport(value: unknown) {
			const client = fakeClient({ getRunReport: vi.fn().mockResolvedValue(value) });
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			return JSON.parse(firstText(res)) as Record<string, unknown>;
		}

		test.each(["pending", "running"])("a %s run's report is marked partial", async (status) => {
			const out = await readReport(report(status));
			expect(out.partial).toBe(true);
			expect(out.note).toMatch(
				/has not finished.*no budget verdict.*get_run\(runId\)\.terminal/
			);
			expect(out.summary).toEqual({ totalRequests: 0 });
		});

		test("a report that took the bounds' early return is marked too", async () => {
			// No `results` array: boundRunReport hands the value back untouched.
			const out = await readReport(report("running"));
			expect(out.partial).toBe(true);
		});

		test("a row-carrying report is marked after its traces are bounded", async () => {
			const out = await readReport(
				report("running", { results: [{ id: 1, trace: { response: { body: "x" } } }] })
			);
			expect(out.partial).toBe(true);
			expect((out.results as unknown[]).length).toBe(1);
		});

		test.each(["completed", "failed", "stopped"])(
			"a %s run's report carries no partial marker at all",
			async (status) => {
				const out = await readReport(report(status));
				expect(out).not.toHaveProperty("partial");
				expect(out).not.toHaveProperty("note");
			}
		);

		test("a report with no metadata is handed back as it came", async () => {
			const answer = { latency: {}, summary: {}, statusCodes: {} };
			expect(await readReport(answer)).toEqual(answer);
		});

		test("the description leads with the partial rule and names metadata.status", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
			expect(description).toMatch(
				/^Get the report for a run; a run still in progress returns a partial report marked `partial: true`/
			);
			expect(description).toContain("metadata.status");
		});

		test("the description names the summary flags and keeps them apart from the top-level partial (#2895)", () => {
			const description = descriptionOf(TOOLS.find((t) => t.name === "get_run_report"));
			expect(description).toContain("`summary.partial: true`");
			expect(description).toContain("`summary.summaryMissing: true`");
			expect(description).toMatch(/neither is the top-level `partial`/);
			expect(description).toMatch(/absent otherwise, never false/);
		});

		test("a report's summary flags reach the agent and satisfy the output schema", async () => {
			const flagged = {
				metadata: { runId: "run_1", runType: "load", status: "failed" },
				summary: { totalRequests: 0, summaryMissing: true },
				results: [],
			};
			const client = fakeClient({ getRunReport: vi.fn().mockResolvedValue(flagged) });
			const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
			expect(res.isError).toBeFalsy();
			const schema = TOOLS.find((t) => t.name === "get_run_report")!.outputSchema!;
			expect(schema.safeParse(res.structuredContent).success).toBe(true);
			// Named in the schema, so a non-boolean is a contract break and not a pass-through.
			expect(schema.safeParse({ summary: { partial: "yes" } }).success).toBe(false);
			expect(res.structuredContent).toMatchObject({ summary: { summaryMissing: true } });
			// Not the top-level marker of an unfinished run.
			expect(res.structuredContent).not.toHaveProperty("partial");
		});
	});

	describe("start tools name the status read", () => {
		const allow = { allowlist: ["api.example.com"] };

		function startClient() {
			return fakeClient({
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/login" }),
			});
		}

		async function started(tool: string, args: Record<string, unknown>) {
			const res = await dispatchTool(tool, args, ctxWith(startClient(), allow));
			expect(res.isError).toBeFalsy();
			return {
				body: JSON.parse(firstText(res)) as Record<string, unknown>,
				structured: res.structuredContent,
			};
		}

		const NEXT_STEP_MENTIONS = [
			/get_run\(runId\)/,
			/completed, failed or stopped/,
			/get_run_report/,
		];

		test("a single-target load run carries nextStep with the poll interval from its duration", async () => {
			const { body, structured } = await started("start_load_run", {
				url: "https://api.example.com/x",
				duration: "30s",
				confirmed: true,
			});
			expect(body.runId).toBe("run_1");
			const nextStep = body.nextStep as string;
			for (const mention of NEXT_STEP_MENTIONS) expect(nextStep).toMatch(mention);
			expect(nextStep).toContain("every 3 s");
			expect(structured).toEqual(body);
		});

		test("an iterations load run polls at the 5 s fallback", async () => {
			const { body } = await started("start_load_run", {
				url: "https://api.example.com/x",
				mode: "iterations",
				iterations: 10,
				confirmed: true,
			});
			expect(body.nextStep).toContain("every 5 s");
		});

		test("a scenario load run carries the same nextStep and no longer says to follow with the report", async () => {
			const res = await dispatchTool(
				"start_load_run",
				{ scenario: { collectionId: "c1" }, duration: "60s", confirmed: true },
				ctxWith(startClient(), allow)
			);
			expect(res.isError).toBeFalsy();
			const body = JSON.parse(firstText(res)) as Record<string, unknown>;
			for (const mention of NEXT_STEP_MENTIONS)
				expect(body.nextStep as string).toMatch(mention);
			expect(body.nextStep).toContain("every 6 s");
			const everything = res.content
				.map((part) => (part as { text: string }).text)
				.join("\n");
			expect(everything).not.toContain("Follow the run with");
		});

		test("run_collection carries the same nextStep field", async () => {
			const { body } = await started("run_collection", { collectionId: "c1" });
			for (const mention of NEXT_STEP_MENTIONS)
				expect(body.nextStep as string).toMatch(mention);
			expect(body.nextStep).toContain("every 5 s");
			expect(body.plannedSteps).toBe(1);
		});

		test("a start answer that is not an object is handed back as it came", async () => {
			const client = fakeClient({
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
				startRun: vi.fn().mockResolvedValue("accepted"),
			});
			const res = await dispatchTool(
				"start_load_run",
				{ url: "https://api.example.com/x", confirmed: true },
				ctxWith(client, allow)
			);
			expect(JSON.parse(firstText(res))).toBe("accepted");
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
			expect(Object.keys(schema).sort()).toEqual(["allowedOrigins", "port", "response"]);
		});
	});

	describe("start_webhook_inbox", () => {
		test("forwards allowedOrigins and still never a bind", async () => {
			const client = fakeClient();
			const origins = ["https://app.example.com", "http://localhost:5173"];
			const res = await dispatchTool(
				"start_webhook_inbox",
				{ port: 45002, allowedOrigins: origins, bind: "0.0.0.0", confirmNonLoopback: true },
				ctxWith(client)
			);
			expect(res.isError).toBeFalsy();
			expect(forwarded(client, "startInbox")[0]).toEqual({
				port: 45002,
				allowedOrigins: origins,
			});
		});

		test("sends no allowedOrigins when the caller named none", async () => {
			const client = fakeClient();
			await dispatchTool("start_webhook_inbox", { port: 45003 }, ctxWith(client));
			expect(forwarded(client, "startInbox")[0]).not.toHaveProperty("allowedOrigins");
		});

		test("the schema takes an array of strings and leaves the origin rules to the engine", () => {
			const shape = byName().get("start_webhook_inbox")?.inputSchema as Record<
				string,
				z.ZodType
			>;
			expect(shape.allowedOrigins.safeParse(["https://app.example.com"]).success).toBe(true);
			expect(shape.allowedOrigins.safeParse("https://app.example.com").success).toBe(false);
		});

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
			expect(firstText(res)).toContain('No inbox with id "gone"');
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
			expect(descriptionOf(byName().get("stop_webhook_inbox"))).toMatch(/NOT a delete/);
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
			expect(descriptionOf(byName().get("get_inbox_captures"))).toMatch(/no live stream/i);
		});
	});
});

/** A tool call that reaches the engine's send routes, and which of the two it calls. */
interface McpSender {
	tool: string;
	args: Record<string, unknown>;
	sentTo: "executeRequest" | "startRun";
}

/** Every path that starts a run, each driven by name below. */
const RUN_STARTERS: McpSender[] = [
	{
		tool: "run_request",
		args: { url: "https://api.example.com/x" },
		sentTo: "executeRequest",
	},
	{
		tool: "run_request",
		args: { url: "https://api.example.com/x", stream: true },
		sentTo: "executeRequest",
	},
	{ tool: "run_collection_smoke", args: { collectionId: "c1" }, sentTo: "executeRequest" },
	{ tool: "run_collection", args: { collectionId: "c1" }, sentTo: "startRun" },
	{
		tool: "start_load_run",
		args: { url: "https://api.example.com/x", confirmed: true },
		sentTo: "startRun",
	},
	{
		tool: "start_load_run",
		args: {
			scenario: { collectionId: "c1" },
			mode: "constant_concurrency",
			concurrency: 5,
			duration: "30s",
			confirmed: true,
		},
		sentTo: "startRun",
	},
];

/**
 * Every tool that starts a run says the run is an agent's, and which client's
 * (#1817): History reads `origin` to tell an MCP run from one the user sent.
 * A tool that forgets the stamp records a run as `other`, which no store-level
 * test notices, so each run-starting path is driven here by name.
 */
describe("every run an MCP tool starts carries an MCP origin", () => {
	const allow = { allowlist: ["api.example.com"] };
	const cases = RUN_STARTERS.map((c) => [`${c.tool} ${JSON.stringify(c.args)}`, c] as const);

	/**
	 * One saved request in `c1`; an inline request composes to itself. `extra`
	 * rides every composed payload, for a composition that names an origin.
	 */
	function runClient(extra: Record<string, unknown> = {}) {
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi.fn().mockImplementation((body: { request?: object }) =>
				Promise.resolve({
					...(body.request ?? { method: "GET", url: "https://api.example.com/r1" }),
					...extra,
				})
			),
		});
	}

	async function originSent(
		{ tool, args, sentTo }: McpSender,
		clientName?: () => string | undefined,
		composedExtra?: Record<string, unknown>
	): Promise<unknown> {
		const client = runClient(composedExtra);
		const res = await dispatchTool(tool, args, {
			...ctxWith(client, allow),
			...(clientName ? { clientName } : {}),
		});
		expect(res.isError, firstText(res)).toBeFalsy();
		const send = client[sentTo] as ReturnType<typeof vi.fn>;
		expect(send).toHaveBeenCalledTimes(1);
		return (send.mock.calls[0][0] as Record<string, unknown>).origin;
	}

	test.each(cases)("%s names the handshake's client", async (_, starter) => {
		expect(await originSent(starter, () => "claude-code")).toStrictEqual({
			kind: "mcp",
			client: "claude-code",
		});
	});

	test.each(cases)("%s with no known client sends the kind alone", async (_, starter) => {
		// Strict: a `client: undefined` key would serialize away, but it would
		// also mean the omission is an accident of JSON rather than the rule.
		expect(await originSent(starter)).toStrictEqual({ kind: "mcp" });
		expect(await originSent(starter, () => undefined)).toStrictEqual({ kind: "mcp" });
	});

	// Both ways in: an argument, and a payload that already carries one by the
	// time it is sent (composition hands back what it was given).
	test.each(cases)("%s cannot be given another origin", async (_, starter) => {
		const app = { kind: "app" };
		const spoofed = { ...starter, args: { ...starter.args, origin: app } };
		expect(await originSent(spoofed, () => "cursor", { origin: app })).toStrictEqual({
			kind: "mcp",
			client: "cursor",
		});
	});
});

/**
 * Every send carries the session's allowlist as `targetPolicy` (#2521): the
 * engine holds the URL it is about to send, after any pre-request script, to
 * the same rule. A path that forgot it would send wherever a script steered,
 * and no gate here could see it, so each sending tool is driven by name and the
 * scan below fails on a send that skips `asMcpSend`.
 */
describe("every MCP send carries the session's target policy", () => {
	const senders: McpSender[] = [
		...RUN_STARTERS,
		{
			tool: "get_graphql_schema",
			args: { url: "https://api.example.com/graphql" },
			sentTo: "executeRequest",
		},
	];
	const cases = senders.map((c) => [`${c.tool} ${JSON.stringify(c.args)}`, c] as const);

	/** The payload @p sender's one send carried under @p safety. */
	async function payloadSent(
		{ tool, args, sentTo }: McpSender,
		safety: Partial<McpSafetyConfig>,
		composedExtra: Record<string, unknown> = {}
	): Promise<Record<string, unknown>> {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi.fn().mockImplementation((body: { request?: object }) =>
				Promise.resolve({
					...(body.request ?? { method: "GET", url: "https://api.example.com/r1" }),
					...composedExtra,
				})
			),
		});
		// The outcome after the send is the tool's own business (the GraphQL
		// tool refuses a fake introspection answer); the payload is the subject.
		await dispatchTool(tool, args, ctxWith(client, safety));
		const send = client[sentTo] as ReturnType<typeof vi.fn>;
		expect(send).toHaveBeenCalledTimes(1);
		return send.mock.calls[0][0] as Record<string, unknown>;
	}

	/** The `targetPolicy` @p sender's one send carried under @p safety. */
	async function policySent(
		sender: McpSender,
		safety: Partial<McpSafetyConfig>,
		composedExtra: Record<string, unknown> = {}
	): Promise<unknown> {
		return (await payloadSent(sender, safety, composedExtra)).targetPolicy;
	}

	// Composition's answer about itself (#2521) is for the agent that composed;
	// the engine would ignore it on these routes, but it is not part of a send.
	test.each(cases)("%s does not forward composition's deferredVariables", async (_, sender) => {
		const sent = await payloadSent(
			sender,
			{ allowlist: ["api.example.com"] },
			{ deferredVariables: ["token"] }
		);
		expect(sent).not.toHaveProperty("deferredVariables");
	});

	test.each(cases)("%s states the session's allowlist", async (_, sender) => {
		expect(await policySent(sender, { allowlist: ["api.example.com"] })).toStrictEqual({
			allowAll: false,
			allowedHosts: ["api.example.com"],
		});
	});

	test.each(cases)("%s states Allow all hosts", async (_, sender) => {
		expect(await policySent(sender, { allowAll: true })).toStrictEqual({
			allowAll: true,
			allowedHosts: [],
		});
	});

	// Both ways in, as for `origin`: an argument, and a composed payload that
	// already carries one.
	test.each(cases)("%s cannot be given a wider policy", async (_, sender) => {
		const wide = { allowAll: true, allowedHosts: [] };
		const spoofed = { ...sender, args: { ...sender.args, targetPolicy: wide } };
		expect(
			await policySent(spoofed, { allowlist: ["api.example.com"] }, { targetPolicy: wide })
		).toStrictEqual({ allowAll: false, allowedHosts: ["api.example.com"] });
	});

	test("no executeRequest or startRun call in the server skips asMcpSend", () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
			(file) =>
				file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testkit")
		);
		const calls: string[] = [];
		for (const file of sources) {
			const text = readFileSync(path.join(here, file), "utf8");
			for (const call of text.matchAll(/\.(executeRequest|startRun)\(\s*([\w.]*)/g)) {
				calls.push(`${file}: ${call[1]}(${call[2]}`);
			}
		}
		// Seven sends today; a scan that read nothing would pass vacuously.
		expect(calls.length).toBeGreaterThanOrEqual(7);
		expect(calls.filter((call) => !call.endsWith("(asMcpSend"))).toEqual([]);
	});
});

/**
 * The engine's refusal of the URL a script left (#2521) reads as the allowlist
 * gate's own refusal: the host it names, and the same remedy, on each path
 * whose answer an agent reads at once.
 */
describe("an engine target refusal carries the allowlist remedy", () => {
	const refusalMessage =
		'Host "evil.example.com", which the URL about to be sent names, is not allowed by this request\'s target policy (allowed hosts: api.example.com). Nothing was sent.';
	const remedy = "add the host in Vayu Settings → MCP (Target allowlist)";

	// The early gate cannot know a host a pre-request script chooses, so it
	// sends, policy attached, and the engine judges the host once resolved.
	test("a saved request whose host waits on its script reaches the engine", async () => {
		const client = fakeClient({
			composeRequest: vi.fn().mockResolvedValue({
				method: "GET",
				url: "https://{{host}}/x",
				deferredVariables: ["host"],
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ requestId: "r1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError, firstText(res)).toBeFalsy();
		const sent = (client.executeRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(sent.targetPolicy).toStrictEqual({
			allowAll: false,
			allowedHosts: ["api.example.com"],
		});
	});

	test("a buffered run_request answers an error naming the host and the remedy", async () => {
		const client = fakeClient({
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: refusalMessage,
				refusalCode: "target_not_allowed",
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"evil.example.com"');
		expect(firstText(res)).toContain(remedy);
	});

	test("a streaming run_request's 400 answers the same", async () => {
		const client = fakeClient({
			executeRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 400",
						400,
						engineErrorBody("target_not_allowed", refusalMessage)
					)
				),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x", stream: true },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"evil.example.com"');
		expect(firstText(res)).toContain(remedy);
		expect(firstText(res)).not.toContain("Engine error (400)");
	});

	test("a smoke run skips the refused request with the remedy as its reason", async () => {
		const client = fakeClient({
			listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "one" }]),
			composeRequest: vi
				.fn()
				.mockResolvedValue({ method: "GET", url: "https://api.example.com/r1" }),
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: refusalMessage,
				refusalCode: "target_not_allowed",
			}),
		});
		const res = await dispatchTool(
			"run_collection_smoke",
			{ collectionId: "c1" },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		const matrix = res.structuredContent as {
			skipped: number;
			results: Array<{ reason?: string }>;
		};
		expect(matrix.skipped).toBe(1);
		expect(matrix.results[0].reason).toContain(remedy);
	});

	test("an unknown host asks for a resolved URL rather than an allowlist entry", async () => {
		const client = fakeClient({
			executeRequest: vi.fn().mockResolvedValue({
				status: 0,
				errorMessage: "Could not determine the target host.",
				refusalCode: "target_host_unknown",
			}),
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/x" },
			ctxWith(client, { allowAll: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("Resolve the URL before sending.");
		expect(firstText(res)).not.toContain(remedy);
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

	// The rows go through untouched (issue #993): every rule about what a set may
	// be lives engine-side, so a second copy of them here could only drift - and
	// a set the schema quietly dropped would be a run of literal `{{data.*}}`
	// tokens that reads as the feature working.
	test("forwards a data set verbatim, under the engine's own key", async () => {
		const rows = [{ id: "1" }, { id: "2" }];
		const { res, client } = await start({ data: rows });

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({ data: rows });
	});

	test("sends no `data` key when the caller named no rows", async () => {
		const { client } = await start({ comment: "just a note" });
		expect(started(client)).not.toHaveProperty("data");
		expect(started(client)).not.toHaveProperty("dataFileName");
		expect(started(client)).not.toHaveProperty("dataFileHash");
		expect(started(client)).not.toHaveProperty("dataFileCastNumbers");
	});

	// Mutation check: drop the `dataFileCastNumbers` forward in start_load_run's
	// handler and the reading is lost (#2540).
	test("forwards the rows' file name, hash and reading at the top level (#2051)", async () => {
		const rows = [{ id: "1" }];
		const hash = "c".repeat(64);
		const { res, client } = await start({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			data: rows,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
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
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
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
	 * The two keys behind `get_run_samples` (#2447). They are the engine's own
	 * snake_case spellings and a camelCase one would reach it as an unread key,
	 * so the assertion is on the payload, for both load paths.
	 */
	test("the response-sample knobs travel under the engine's own keys", async () => {
		const { res, client } = await start({ responseSamplePeriod: 10, maxResponseSamples: 50 });

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			response_sample_rate: 10,
			max_response_samples: 50,
		});
		expect(started(client)).not.toHaveProperty("responseSamplePeriod");
		expect(started(client)).not.toHaveProperty("maxResponseSamples");
	});

	test("zero samples is a legal request and is sent, not dropped", async () => {
		const { client } = await start({ maxResponseSamples: 0 });
		expect(started(client)).toMatchObject({ max_response_samples: 0 });
	});

	test("the response-sample knobs are absent when not named", async () => {
		const { client } = await start({ comment: "just a note" });
		expect(started(client)).not.toHaveProperty("response_sample_rate");
		expect(started(client)).not.toHaveProperty("max_response_samples");
	});

	test("the confirmation preview shows both knobs", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				url: "https://api.example.com/users",
				responseSamplePeriod: 10,
				maxResponseSamples: 50,
			},
			ctxWith(client, allow)
		);

		expect(client.startRun).not.toHaveBeenCalled();
		expect(firstText(res)).toMatch(/"response_sample_rate": 10/);
		expect(firstText(res)).toMatch(/"max_response_samples": 50/);
	});

	test("a scenario load run carries the response-sample knobs", async () => {
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
				responseSamplePeriod: 10,
				maxResponseSamples: 50,
			},
			ctxWith(client, allow)
		);

		expect(res.isError).toBeFalsy();
		expect(started(client)).toMatchObject({
			response_sample_rate: 10,
			max_response_samples: 50,
		});
	});

	test("the schema holds the response-sample knobs to the engine's bounds", () => {
		const schema = z.object(
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
		);
		// A period of 0 is a division by zero engine-side.
		expect(schema.safeParse({ responseSamplePeriod: 0 }).success).toBe(false);
		expect(schema.safeParse({ responseSamplePeriod: 1 }).success).toBe(true);
		expect(schema.safeParse({ responseSamplePeriod: MAX_RESPONSE_SAMPLE_PERIOD }).success).toBe(
			true
		);
		expect(
			schema.safeParse({ responseSamplePeriod: MAX_RESPONSE_SAMPLE_PERIOD + 1 }).success
		).toBe(false);
		expect(schema.safeParse({ maxResponseSamples: -1 }).success).toBe(false);
		expect(schema.safeParse({ maxResponseSamples: 0 }).success).toBe(true);
		expect(schema.safeParse({ maxResponseSamples: MAX_RESPONSE_SAMPLES_BOUND }).success).toBe(
			true
		);
		expect(
			schema.safeParse({ maxResponseSamples: MAX_RESPONSE_SAMPLES_BOUND + 1 }).success
		).toBe(false);
	});

	/**
	 * The chain `load-test.engine-parity.test.ts` starts: that file ties the
	 * renderer's ceiling to the engine header and route, this ties the MCP
	 * schema bound and the cap's ceiling to the renderer's.
	 */
	test("the schema bound and the cap's ceiling are the engine's maximum", () => {
		expect(MAX_RESPONSE_SAMPLES_BOUND).toBe(RESPONSE_SAMPLES_CEILING);
		expect(MCP_CAP_CEILINGS.maxResponseSamples).toBe(RESPONSE_SAMPLES_CEILING);
		expect(MAX_RESPONSE_SAMPLE_PERIOD).toBe(100_000);
	});

	test("a sample count above the MCP cap is refused before anything starts", async () => {
		const tight = { ...allow, maxResponseSamples: 100 };
		const client = fakeClient();
		const single = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true, maxResponseSamples: 101 },
			ctxWith(client, tight)
		);
		const scenario = await dispatchTool(
			"start_load_run",
			{ scenario: { collectionId: "col_1" }, confirmed: true, maxResponseSamples: 101 },
			ctxWith(client, tight)
		);

		for (const res of [single, scenario]) {
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/maxResponseSamples 101 exceeds the MCP cap of 100/);
		}
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("a cap below the engine default refuses a run that states no count", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/users", confirmed: true },
			ctxWith(client, { ...allow, maxResponseSamples: 100 })
		);

		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/maxResponseSamples 1000 \(the engine's default/);
		expect(client.startRun).not.toHaveBeenCalled();
	});

	/**
	 * The "written but never read" guard for descriptions: a switch the sample
	 * reader says `start_load_run` sets has to be an argument an agent can pass.
	 * Scoped to the sentence naming `start_load_run`, because the same description
	 * also names the *output* fields (`resultId`, `bodyTruncated`) of a sample.
	 */
	test("every argument get_run_samples attributes to start_load_run exists there", () => {
		const samples = TOOLS.find((t) => t.name === "get_run_samples")!;
		const load = TOOLS.find((t) => t.name === "start_load_run")!;
		const description = resolveDescription(samples, resolveSafetyConfig());
		const sentences = description.split(". ").filter((s) => s.includes("start_load_run"));
		const named = [
			...new Set(sentences.flatMap((s) => s.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? [])),
		];

		// A scan that found nothing would pass forever.
		expect(named).toEqual(["responseSamplePeriod", "maxResponseSamples"]);
		for (const name of named) {
			expect(Object.keys(load.inputSchema), `${name} is named by get_run_samples`).toContain(
				name
			);
		}
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
			TOOLS.find((t) => t.name === "start_load_run")!.inputSchema as Record<string, z.ZodType>
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
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "yaml", "contract", undefined);
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
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "json", "contract", undefined);
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.document, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.documentTruncated).toBe(true);
		// The cut says what it is a prefix of - a length read off the truncated
		// text would tell an agent the document is 32 KB.
		expect(value.contentBytes).toBe(document.length);
	});

	test("export_spec asks for a write-everything export when told to", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_spec",
			{ collectionId: "col_1", mode: "full" },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportSpec).toHaveBeenCalledWith("col_1", "json", "full", undefined);
		expect(JSON.parse(firstText(res)).mode).toBe("full");
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

	test("export_postman asks the engine for the document with secrets omitted", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"export_postman",
			// An argument the schema does not declare is not a way in: the
			// secrets stay out whatever the caller sends.
			{ collectionId: "col_1", includeSecrets: true },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		expect(client.exportPostman).toHaveBeenCalledWith("col_1", undefined);
		expect(client.listRequests).not.toHaveBeenCalled();
		const value = JSON.parse(firstText(res));
		expect(value).toMatchObject({
			collectionId: "col_1",
			fileName: "API.postman_collection.json",
			documentTruncated: false,
		});
		expect(value.notes.secretsOmitted).toBe(1);
		expect(value.notes.notCarried).toEqual([
			{ code: "load-test", count: 1, message: "Load-test settings" },
		]);
		expect(value.document).toContain("info");
	});

	test("export_postman caps a document too large to hand back whole", async () => {
		const document = `{"info":{},"x":"${"a".repeat(MAX_INLINE_BODY_BYTES)}"}`;
		const client = fakeClient({
			exportPostman: vi.fn().mockResolvedValue({
				text: document,
				fileName: "API.postman_collection.json",
				notes: {},
			}),
		});
		const res = await dispatchTool(
			"export_postman",
			{ collectionId: "col_1" },
			ctxWith(client)
		);
		const value = JSON.parse(firstText(res));
		expect(Buffer.byteLength(value.document, "utf8")).toBeLessThanOrEqual(
			MAX_INLINE_BODY_BYTES
		);
		expect(value.documentTruncated).toBe(true);
		expect(value.contentBytes).toBe(document.length);
	});

	test("export_postman passes the engine's refusal through", async () => {
		const client = fakeClient({
			exportPostman: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError(
						"Engine responded 404",
						404,
						"Collection 'nope' not found"
					)
				),
		});
		const res = await dispatchTool("export_postman", { collectionId: "nope" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(allText(res)).toContain("nope");
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

	/**
	 * Importing a document over MCP (issue #877).
	 *
	 * The verb the spec tools were missing: an agent could bind, describe, diff,
	 * sync, export and unbind, and could not *import*, because the apply took a
	 * tree only the renderer could build. What this file holds down is the tool's
	 * half - the guard, the options travelling verbatim, and the losses being said
	 * out loud - since what a document parses to is the engine's and pinned there.
	 */
	describe("import_document", () => {
		test("is refused while writes are off, and sends nothing", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(client, { allowWrites: false })
			);
			expect(res.isError).toBe(true);
			expect(client.importDocument).not.toHaveBeenCalled();
		});

		test("sends the document and the options the caller stated, and nothing else", async () => {
			const client = fakeClient();
			const res = await dispatchTool(
				"import_document",
				{
					content: '{"info":{}}',
					importScripts: false,
					sourceUrl: "https://acme.dev/api.json",
				},
				ctxWith(client, WRITES)
			);
			expect(res.isError).toBeFalsy();
			const [payload] = (client.importDocument as ReturnType<typeof vi.fn>).mock.calls[0];
			// An option the caller did not state is absent rather than defaulted here:
			// the engine's default is the one the import dialog offers, and restating
			// it would be a second place for it to drift.
			expect(payload).toEqual({
				content: '{"info":{}}',
				importScripts: false,
				sourceUrl: "https://acme.dev/api.json",
			});
		});

		test("says what was created and what the document lost", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(fakeClient(), WRITES)
			);
			expect(res.isError).toBeFalsy();
			expect(allText(res)).toContain("Postman Collection v2.1");
			expect(allText(res)).toContain("2 request(s)");
			// The half a caller cannot see from the counts: an import that dropped a
			// WebSocket request looks exactly like one that had none.
			expect(allText(res)).toMatch(/Not everything imported: 1 websocket/);
		});

		test("names the sub-collections the requests went into and the one-call way to run them", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(
					fakeClient({
						importDocument: vi.fn().mockResolvedValue({
							meta: {
								format: "OpenAPI 3.1.0",
								requestCount: 9,
								folderCount: 3,
								skipped: [],
							},
							collections: 4,
							requests: 9,
							environments: 0,
							globals: 0,
						}),
					}),
					WRITES
				)
			);
			expect(allText(res)).toContain("filed under 3 sub-collection(s)");
			expect(allText(res)).toContain(
				"recursive: true to run_collection or run_collection_smoke"
			);
		});

		test("a preview names the one-call way to run the folders it would create", () => {
			const meta = { format: "OpenAPI 3.1.0", requestCount: 9, skipped: [] };
			expect(describeImportPreview({ meta: { ...meta, folderCount: 3 } })).toContain(
				"recursive: true to run_collection or run_collection_smoke"
			);
			expect(describeImportPreview({ meta: { ...meta, folderCount: 0 } })).not.toContain(
				"recursive"
			);
		});

		test("tells the caller how to define {{baseUrl}} when the document named no server (#2450)", () => {
			const base = { format: "OpenAPI 3.1.0", requestCount: 2, folderCount: 0 };
			const noServer = { ...base, skipped: [{ kind: "no_server_url", count: 1 }] };
			const other = { ...base, skipped: [{ kind: "websocket", count: 1 }] };
			expect(noServer.skipped.map((s) => s.kind)).toContain("no_server_url");
			const remedy = "{{baseUrl}} is undefined";
			const imported = { collections: 1, requests: 2, environments: 0, globals: 0 };

			const preview = describeImportPreview({ meta: noServer });
			expect(preview).toContain(remedy);
			expect(preview).toContain("update_collection");
			expect(preview).toContain("update_environment");
			expect(describeImportPreview({ meta: other })).not.toContain(remedy);
			expect(describeImportPreview({ meta: { ...base, skipped: [] } })).not.toContain(remedy);

			const done = describeImport({ ...imported, meta: noServer });
			expect(done).toContain(remedy);
			expect(done).toContain("update_collection");
			expect(done).toContain("update_environment");
			expect(describeImport({ ...imported, meta: other })).not.toContain(remedy);
			expect(describeImport({ ...imported, meta: { ...base, skipped: [] } })).not.toContain(
				remedy
			);
		});

		test("adds nothing about sub-collections when the document made none", async () => {
			const res = await dispatchTool(
				"import_document",
				{ content: "{}" },
				ctxWith(
					fakeClient({
						importDocument: vi.fn().mockResolvedValue({
							meta: {
								format: "OpenAPI 3.1.0",
								requestCount: 2,
								folderCount: 0,
								skipped: [],
							},
							collections: 1,
							requests: 2,
							environments: 0,
							globals: 0,
						}),
					}),
					WRITES
				)
			);
			expect(allText(res)).toContain(
				"Imported OpenAPI 3.1.0: 1 collection(s), 2 request(s)."
			);
			expect(allText(res)).not.toContain("sub-collection");
			expect(allText(res)).not.toContain("recursive");
		});

		test("passes the engine's refusal through rather than inventing one", async () => {
			const client = fakeClient({
				importDocument: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 400", 400, "Unrecognised format")
					),
			});
			const res = await dispatchTool(
				"import_document",
				{ content: '{"x":1}' },
				ctxWith(client, WRITES)
			);
			expect(res.isError).toBe(true);
			expect(allText(res)).toContain("Unrecognised format");
		});
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
		expect(tools.get("export_postman")?.category).toBe("read");
		expect(tools.get("export_postman")?.invalidates).toEqual([]);
		expect(tools.get("export_postman")?.annotations.readOnlyHint).toBe(true);
		expect(tools.get("unbind_spec")?.category).toBe("write");
		// The Spec tab reads the binding off the collection row, so the family that
		// refetches that row is the one that refreshes it - no `spec` entity, and
		// no request list, since the stamps stay where they are.
		expect(tools.get("unbind_spec")?.invalidates).toEqual(["collectionRow"]);
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

describe("variable precedence is stated wherever a variable is written or listed", () => {
	/**
	 * The surfaces an agent reaches when it changes or surveys a value. Before
	 * issue #1207 the resolution order appeared in `run_request` and
	 * `get_globals` alone - never at a tool that writes one - so an agent
	 * "fixed" a value in a tier something above it shadowed and saw no effect
	 * and no explanation.
	 *
	 * Table-driven so a new variable tool cannot quietly omit the sentence: add
	 * one to this list and it is checked, and the list is what a reviewer reads
	 * to see whether it is complete.
	 */
	/**
	 * Derived, not listed: every tool taking a `variables` argument is a tool
	 * that writes a tier, so a new one is covered the day it is written. A
	 * hand-maintained list would only ever pin the tools someone remembered to
	 * add to it, which is the defect this issue was opened about wearing a
	 * different hat.
	 */
	const VARIABLE_WRITERS = TOOLS.filter((t) => "variables" in t.inputSchema);

	/**
	 * The read and activation surfaces, which take no `variables` argument and
	 * so cannot be derived the same way. Listed, and the list is asserted
	 * complete below against every tool whose description mentions variables.
	 */
	const VARIABLE_READERS = [
		"get_globals",
		"list_environments",
		"list_collections",
		"activate_environment",
		"resolve_variables",
	] as const;

	test("the derived writer set is non-empty and is what we think it is", () => {
		// A guard over a filter that silently matched nothing would pass forever.
		expect(VARIABLE_WRITERS.length).toBeGreaterThan(0);
		expect(VARIABLE_WRITERS.map((t) => t.name).sort()).toEqual([
			"create_collection",
			"create_environment",
			"update_collection",
			"update_environment",
			"update_globals",
		]);
	});

	test.each(VARIABLE_WRITERS.map((t) => [t.name, t] as const))(
		"%s (writes a tier) states the order and links the model",
		(_name, tool) => {
			// Mutation check: drop the precedenceNote() call from any one of these
			// descriptions and that row fails.
			expect(descriptionOf(tool)).toContain(VARIABLE_PRECEDENCE_SENTENCE);
			expect(descriptionOf(tool)).toContain(VARIABLE_RESOLUTION_URI);
		}
	);

	test.each(VARIABLE_READERS)("%s (reads or switches a tier) states it too", (name) => {
		const tool = TOOLS.find((t) => t.name === name);
		expect(tool, `${name} is missing from TOOLS`).toBeDefined();
		expect(descriptionOf(tool)).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(descriptionOf(tool)).toContain(VARIABLE_RESOLUTION_URI);
	});

	test("no tool spells the order its own way any more", () => {
		// The original complaint: the order appeared as prose in two tools and
		// nowhere else. A second spelling is how it drifts back apart.
		const rogue = TOOLS.filter(
			(t) =>
				/environment\s*>\s*collection\s*chain\s*>\s*globals/.test(descriptionOf(t)) &&
				!descriptionOf(t).includes(VARIABLE_RESOLUTION_URI)
		);
		expect(rogue.map((t) => t.name)).toEqual([]);
	});

	test("each surface names its own tier's position, not just the ladder", () => {
		const byName = new Map(TOOLS.map((t) => [t.name, t]));
		// A shared sentence alone would pass the scan above while telling an
		// agent nothing about the tier it is writing to.
		expect(descriptionOf(byName.get("update_globals"))).toMatch(/bottom tier/);
		expect(descriptionOf(byName.get("update_environment"))).toMatch(/top scope tier/);
		expect(descriptionOf(byName.get("create_collection"))).toMatch(
			/between globals and the active environment/
		);
	});

	test("the variablesInput helper carries it too, at the field an agent fills", () => {
		// Reached through the schema rather than the description: a client that
		// renders per-field docs shows this and not the tool blurb.
		const schema = TOOLS.find((t) => t.name === "update_environment")?.inputSchema.variables;
		expect(schema?.description).toContain(VARIABLE_PRECEDENCE_SENTENCE);
		expect(schema?.description).toContain(VARIABLE_RESOLUTION_URI);
	});
});

describe("resolve_variables", () => {
	const GLOBALS = {
		variables: {
			host: { value: "globals.test", enabled: true },
			onlyGlobal: { value: "g", enabled: true },
		},
	};
	const COLLECTIONS = [
		{
			id: "root",
			name: "Root",
			parentId: null,
			variables: { host: { value: "root.test", enabled: true } },
		},
		{
			id: "leaf",
			name: "Leaf",
			parentId: "root",
			variables: { host: { value: "leaf.test", enabled: true } },
		},
	];
	const ENVIRONMENTS = [
		{
			id: "env_active",
			name: "Staging",
			isActive: true,
			variables: { host: { value: "staging.test", enabled: true } },
		},
		{
			id: "env_other",
			name: "Prod",
			isActive: false,
			variables: { host: { value: "prod.test", enabled: true } },
		},
	];

	const variableClient = (overrides = {}) =>
		fakeClient({
			getGlobals: vi.fn().mockResolvedValue(GLOBALS),
			listCollections: vi.fn().mockResolvedValue(COLLECTIONS),
			listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS),
			...overrides,
		});

	const resolve = async (args: Record<string, unknown>, client = variableClient()) =>
		JSON.parse(
			firstText(
				(await dispatchTool("resolve_variables", args, ctxWith(client))) as {
					content: Array<{ text: string }>;
				}
			)
		);

	test("is a read tool that changes nothing", () => {
		const tool = TOOLS.find((t) => t.name === "resolve_variables");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations.readOnlyHint).toBe(true);
	});

	test("the active environment wins, and every loser is named with its reason", async () => {
		const out = await resolve({ collectionId: "leaf" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");

		expect(host.value).toBe("staging.test");
		expect(host.scope).toBe("environment");
		expect(host.sourceName).toBe("Staging");
		// Highest precedence first: the nearest miss is the one to read first.
		expect(host.shadowedBy).toEqual([
			{
				scope: "collection",
				sourceId: "leaf",
				sourceName: "Leaf",
				value: "leaf.test",
				enabled: true,
				reason: "outranked",
			},
			{
				scope: "collection",
				sourceId: "root",
				sourceName: "Root",
				value: "root.test",
				enabled: true,
				reason: "outranked",
			},
			{ scope: "global", value: "globals.test", enabled: true, reason: "outranked" },
		]);
	});

	test("the collection chain is only in play when a collectionId is given", async () => {
		const out = await resolve({});
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("staging.test");
		// Two definitions, not four: no chain was asked for.
		expect(host.shadowedBy).toEqual([
			{ scope: "global", value: "globals.test", enabled: true, reason: "outranked" },
		]);
		expect(out.context.collectionChain).toEqual([]);
	});

	test('"none" resolves as if no environment were active', async () => {
		const out = await resolve({ collectionId: "leaf", environmentId: "none" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("leaf.test");
		expect(host.scope).toBe("collection");
		expect(out.context.environmentSelection).toBe("explicitly none");
		expect(out.context.environmentId).toBeNull();
	});

	test("a named environment is used over the active one", async () => {
		const out = await resolve({ environmentId: "env_other" });
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("prod.test");
		expect(out.context.environmentSelection).toBe("named by the caller");
	});

	test("an id that names nothing is refused, not resolved as empty", async () => {
		// The whole point: silently resolving a typo'd collection against globals
		// alone would report confident, wrong answers.
		const missingCollection = await dispatchTool(
			"resolve_variables",
			{ collectionId: "ghost" },
			ctxWith(variableClient())
		);
		expect(missingCollection.isError).toBe(true);
		expect(firstText(missingCollection)).toContain('No collection with id "ghost"');

		const missingEnv = await dispatchTool(
			"resolve_variables",
			{ environmentId: "ghost" },
			ctxWith(variableClient())
		);
		expect(missingEnv.isError).toBe(true);
		expect(firstText(missingEnv)).toContain('No environment with id "ghost"');
	});

	test("names selects, and a name nothing defines is reported rather than omitted", async () => {
		const out = await resolve({ names: ["onlyGlobal", "nowhere"] });
		expect(out.variables.map((v: { name: string }) => v.name)).toEqual([
			"onlyGlobal",
			"nowhere",
		]);
		const nowhere = out.variables[1];
		expect(nowhere.resolved).toBe(false);
		expect(nowhere.shadowedBy).toEqual([]);
	});

	test("a malformed names argument is an argument error, not an empty answer", async () => {
		const res = await dispatchTool(
			"resolve_variables",
			{ names: ["ok", 7] },
			ctxWith(variableClient())
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('"names" must be an array of strings');
	});

	test("a secret's value is withheld while the rest of the report stands", async () => {
		const client = variableClient({
			getGlobals: vi.fn().mockResolvedValue({
				variables: { token: { value: "s3cret", enabled: true, secret: true } },
			}),
			listEnvironments: vi.fn().mockResolvedValue([]),
		});
		const out = await resolve({}, client);
		const token = out.variables.find((v: { name: string }) => v.name === "token");
		expect(token.resolved).toBe(true);
		expect(token.valueWithheld).toBe(true);
		expect(token).not.toHaveProperty("value");
		expect(JSON.stringify(out)).not.toContain("s3cret");
	});

	test("a disabled winner falls through, and says it was switched off", async () => {
		const client = variableClient({
			listEnvironments: vi.fn().mockResolvedValue([
				{
					id: "env_active",
					name: "Staging",
					isActive: true,
					variables: { host: { value: "staging.test", enabled: false } },
				},
			]),
		});
		const out = await resolve({}, client);
		const host = out.variables.find((v: { name: string }) => v.name === "host");
		expect(host.value).toBe("globals.test");
		expect(host.shadowedBy[0]).toMatchObject({ scope: "environment", reason: "disabled" });
	});

	test("summary counts what the report holds", async () => {
		const out = await resolve({ collectionId: "leaf" });
		expect(out.summary.reported).toBe(out.variables.length);
		expect(out.summary.resolved).toBe(
			out.variables.filter((v: { resolved: boolean }) => v.resolved).length
		);
		expect(out.summary.shadowed).toBe(1); // `host` only; `onlyGlobal` is unopposed
	});

	test("an engine failure reads as an engine failure, not a bad argument", async () => {
		const client = variableClient({
			getGlobals: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const res = await dispatchTool("resolve_variables", {}, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).not.toContain("must be an array");
	});

	/**
	 * Every tool that composes with an environment picks it the way
	 * resolve_variables does (#2480): the active row for an omitted id, none for
	 * "none", a refusal for an id no environment has.
	 */
	describe("a send resolves against the environment the preview names", () => {
		type Spy = ReturnType<typeof vi.fn>;
		interface Send {
			label: string;
			tool: string;
			args: Record<string, unknown>;
			/** The environment the engine runs with, when it is not the compose body's. */
			forwarded?: (client: EngineClient) => unknown;
		}
		const runPayload = (client: EngineClient) =>
			((client.startRun as Spy).mock.calls[0][0] as Record<string, unknown>).environmentId;
		const SENDS: Send[] = [
			{
				label: "run_request",
				tool: "run_request",
				args: { url: "https://api.example.com/x" },
			},
			{
				label: "start_load_run (url)",
				tool: "start_load_run",
				args: { url: "https://api.example.com/x", duration: "30s", confirmed: true },
			},
			{
				label: "start_load_run (requestId)",
				tool: "start_load_run",
				args: { requestId: "r1", duration: "30s", confirmed: true },
			},
			{
				label: "start_load_run (scenario)",
				tool: "start_load_run",
				args: { scenario: { collectionId: "c1" }, duration: "30s", confirmed: true },
				forwarded: runPayload,
			},
			{
				label: "run_collection",
				tool: "run_collection",
				args: { collectionId: "c1" },
				forwarded: runPayload,
			},
			{
				label: "run_collection_smoke",
				tool: "run_collection_smoke",
				args: { collectionId: "c1" },
			},
			{
				label: "get_graphql_schema",
				tool: "get_graphql_schema",
				args: { requestId: "r1" },
				forwarded: (client) =>
					((client.executeRequest as Spy).mock.calls[0][0] as Record<string, unknown>)
						.environmentId,
			},
		];
		const ALLOWED = { allowlist: ["api.example.com"] };

		const sendClient = (environments: unknown[] = ENVIRONMENTS) =>
			fakeClient({
				listEnvironments: vi.fn().mockResolvedValue(environments),
				listRequests: vi.fn().mockResolvedValue([{ id: "r1", name: "login" }]),
				composeRequest: vi
					.fn()
					.mockResolvedValue({ method: "GET", url: "https://api.example.com/x" }),
			});

		/** Every environment the call composed or ran with, one entry per engine call. */
		async function sentEnvironments(
			send: Send,
			args: Record<string, unknown>,
			client = sendClient()
		) {
			await dispatchTool(send.tool, args, ctxWith(client, ALLOWED));
			const composed = (client.composeRequest as Spy).mock.calls.map(
				([body]) => (body as Record<string, unknown>).environmentId
			);
			expect(composed.length).toBeGreaterThan(0);
			return send.forwarded ? [...composed, send.forwarded(client)] : composed;
		}

		test.each(SENDS)("$label with no environmentId uses the active one", async (send) => {
			const sent = await sentEnvironments(send, send.args);
			expect(new Set(sent)).toEqual(new Set(["env_active"]));
		});

		test.each(SENDS)('$label with "none" composes with no environment', async (send) => {
			const sent = await sentEnvironments(send, { ...send.args, environmentId: "none" });
			expect(new Set(sent)).toEqual(new Set([undefined]));
		});

		test.each(SENDS)(
			"$label with none active and none named has no environment",
			async (send) => {
				const inactive = ENVIRONMENTS.map((row) => ({ ...row, isActive: false }));
				const sent = await sentEnvironments(send, send.args, sendClient(inactive));
				expect(new Set(sent)).toEqual(new Set([undefined]));
			}
		);

		test.each(SENDS)("$label with a named environment uses that one", async (send) => {
			const sent = await sentEnvironments(send, { ...send.args, environmentId: "env_other" });
			expect(new Set(sent)).toEqual(new Set(["env_other"]));
		});

		test.each(SENDS)(
			"$label refuses an unknown environmentId and sends nothing",
			async (send) => {
				const client = sendClient();
				const res = await dispatchTool(
					send.tool,
					{ ...send.args, environmentId: "ghost" },
					ctxWith(client, ALLOWED)
				);
				expect(res.isError).toBe(true);
				expect(firstText(res)).toContain('No environment with id "ghost"');
				expect(client.composeRequest).not.toHaveBeenCalled();
				expect(client.executeRequest).not.toHaveBeenCalled();
				expect(client.startRun).not.toHaveBeenCalled();
			}
		);

		test("resolve_variables and run_request name the same environment", async () => {
			const preview = await resolve({});
			const sent = await sentEnvironments(SENDS[0], SENDS[0].args);
			expect(preview.context.environmentId).toBe("env_active");
			expect(sent).toEqual([preview.context.environmentId]);
		});

		test("every tool that takes environmentId states the one default", () => {
			const names = [
				"resolve_variables",
				"activate_environment",
				...new Set(SENDS.map((send) => send.tool)),
			];
			const read = names.filter((name) => {
				const tool = TOOLS.find((t) => t.name === name);
				const param = tool?.inputSchema.environmentId?.description ?? "";
				return `${descriptionOf(tool)} ${param}`.includes(ENVIRONMENT_DEFAULT_SENTENCE);
			});
			expect(ENVIRONMENT_DEFAULT_SENTENCE).not.toBe("");
			expect(read).toEqual([
				"resolve_variables",
				"activate_environment",
				"run_request",
				"start_load_run",
				"run_collection",
				"run_collection_smoke",
				"get_graphql_schema",
			]);
		});
	});
});

/**
 * The whole-list reads page through the engine (#2443): `q`, `limit` and
 * `offset` are forwarded, and a row is a summary unless `fields: "full"` asks
 * for the whole one. The summary is cut after the withholding pass, because a
 * request's url is masked by reading its auth.
 */
describe("the paged whole-list reads", () => {
	const REQUEST_ROWS = Array.from({ length: 5 }, (_, i) => ({
		id: `req_${i + 1}`,
		collectionId: "col_1",
		name: `Request ${i + 1}`,
		method: "POST",
		url: `https://api.example.com/items/${i + 1}`,
		order: i,
		params: [],
		headers: [{ key: "Accept", value: "application/json", enabled: true }],
		body: { mode: "raw", raw: "{}" },
		auth: { mode: "inherit" },
		elements: [{ kind: "script.pre", config: { source: "pm.environment.set('a', 1)" } }],
		updatedAt: 1_755_000_000_000,
		createdAt: 1_755_000_000_000,
	}));

	/** The engine's paging over @p rows: the slice the query names, with the total behind it. */
	const pagingEngine = (rows: unknown[]) =>
		vi.fn(async (_collectionId: string, query: { limit: number; offset: number }) =>
			page(rows.slice(query.offset, query.offset + query.limit), rows.length, query.offset)
		);

	const listRequests = async (args: Record<string, unknown>, rows: unknown[] = REQUEST_ROWS) => {
		const client = fakeClient({ listRequestsPage: pagingEngine(rows) });
		const res = await dispatchTool(
			"list_requests",
			{ collectionId: "col_1", ...args },
			ctxWith(client)
		);
		expect(res.isError).toBeFalsy();
		return { client, text: firstText(res), body: JSON.parse(firstText(res)) };
	};

	test("a summary row carries the request's identity and none of its content", async () => {
		const { body } = await listRequests({});
		expect(body.data).toHaveLength(5);
		expect(body.data[0]).toEqual({
			id: "req_1",
			collectionId: "col_1",
			name: "Request 1",
			method: "POST",
			url: "https://api.example.com/items/1",
			order: 0,
			updatedAt: 1_755_000_000_000,
		});
		for (const row of body.data) {
			for (const key of ["body", "headers", "params", "auth", "elements"]) {
				expect(row, key).not.toHaveProperty(key);
			}
		}
	});

	test('fields: "full" answers each whole stored row', async () => {
		const { body } = await listRequests({ fields: "full" });
		expect(body.data).toEqual(REQUEST_ROWS);
	});

	test("q, limit and offset reach the engine, and nothing else is the unpaged read", async () => {
		const { client } = await listRequests({ q: "request 3", limit: 10, offset: 0 });
		expect(client.listRequestsPage).toHaveBeenCalledWith(
			"col_1",
			{ q: "request 3", limit: 10, offset: 0 },
			undefined
		);
		expect(client.listRequests).not.toHaveBeenCalled();
	});

	test("an unstated page is the engine's default page", async () => {
		const { client } = await listRequests({});
		expect(client.listRequestsPage).toHaveBeenCalledWith(
			"col_1",
			{ limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
	});

	test("limit: 2 answers two rows and says where the next page starts", async () => {
		const { body } = await listRequests({ limit: 2 });
		expect(body.data.map((row: { id: string }) => row.id)).toEqual(["req_1", "req_2"]);
		expect(body.pagination).toMatchObject({ total: 5, hasMore: true, nextOffset: 2 });
		expect(body.pagination.note).toMatch(/2 of 5 requests/);
	});

	// Mutation check: project before withholding and the key reaches the summary,
	// because the API-key-in-query rule reads the row's auth, which the summary drops.
	test("a summary row's url is masked as the whole row's is, auth-placed key included", async () => {
		const secretRow = {
			...REQUEST_ROWS[0],
			url: "https://ops:pw-777@api.example.com/v1?tenant-key=tk-999&page=2",
			auth: { mode: "apikey", key: "tenant-key", value: "tk-999", in: "query" },
		};
		const { text, body } = await listRequests({}, [secretRow]);
		expect(text).not.toContain("tk-999");
		expect(text).not.toContain("pw-777");
		expect(body.data[0].url).toBe("https://ops@api.example.com/v1?tenant-key=&page=2");
	});

	test.each([
		[{ limit: MAX_ENGINE_PAGE_LIMIT + 1 }, String(MAX_ENGINE_PAGE_LIMIT)],
		[{ limit: 0 }, "limit"],
		[{ offset: -1 }, "offset"],
		[{ fields: "everything" }, '"fields"'],
	])("%j is refused before the engine is called", async (args, message) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"list_requests",
			{ collectionId: "col_1", ...args },
			ctxWith(client)
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(message);
		expect(client.listRequestsPage).not.toHaveBeenCalled();
	});

	test("a collection summary row drops its variables, auth and data contract", async () => {
		const collection = {
			id: "col_1",
			name: "API",
			parentId: null,
			order: 0,
			description: "",
			variables: { token: { value: "v-1", enabled: true } },
			auth: { mode: "bearer", token: "{{token}}" },
			dataSchema: { columns: ["id"] },
			createdAt: 1,
			updatedAt: 2,
		};
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page([collection])),
		});
		const summary = await dispatchTool("list_collections", { q: "api" }, ctxWith(client));
		expect(JSON.parse(firstText(summary)).data).toEqual([
			{ id: "col_1", name: "API", parentId: null, order: 0 },
		]);
		expect(client.listCollectionsPage).toHaveBeenCalledWith(
			{ q: "api", limit: DEFAULT_LIST_PAGE_LIMIT, offset: 0 },
			undefined
		);
		const full = await dispatchTool("list_collections", { fields: "full" }, ctxWith(client));
		expect(JSON.parse(firstText(full)).data[0]).toMatchObject({
			variables: collection.variables,
			auth: collection.auth,
			dataSchema: { columns: ["id"] },
		});
		expect(client.listCollections).not.toHaveBeenCalled();
	});

	test("get_cookies forwards its page and filter", async () => {
		const client = fakeClient();
		await dispatchTool("get_cookies", { q: "x.test", limit: 5, offset: 10 }, ctxWith(client));
		expect(client.getCookiesPage).toHaveBeenCalledWith(
			{ q: "x.test", limit: 5, offset: 10 },
			undefined
		);
		expect(client.getCookies).not.toHaveBeenCalled();
	});
});

/**
 * What a read hands an agent in place of a secret (#1805). Every case runs
 * twice: on the default config, where the value must not appear anywhere in
 * the answer, and with `revealSecretsToAgents`, where it must arrive untouched.
 * A read that forgot its projection passes the second and fails the first; a
 * projection that ignores the setting fails the second.
 */
describe("secret withholding", () => {
	const REVEAL = { revealSecretsToAgents: true };
	const ALLOW_API = { allowlist: ["api.example.com"] };

	const read = async (
		tool: string,
		client: EngineClient,
		safety?: Partial<McpSafetyConfig>,
		args: Record<string, unknown> = {}
	) => {
		const res = await dispatchTool(tool, args, ctxWith(client, safety));
		expect(res.isError).toBeFalsy();
		return { text: firstText(res), body: JSON.parse(firstText(res)) };
	};

	/** A paged list read for whole rows, its `data` as `body`. */
	const readFull = async (
		tool: string,
		client: EngineClient,
		safety?: Partial<McpSafetyConfig>,
		args: Record<string, unknown> = {}
	) => {
		const { text, body } = await read(tool, client, safety, { ...args, fields: "full" });
		return { text, body: body.data };
	};

	const ENVIRONMENTS = [
		{
			id: "env_1",
			name: "Staging",
			isActive: true,
			variables: {
				apiKey: { value: "sk-live-123", secret: true, enabled: true },
				baseUrl: { value: "https://staging.test", enabled: true },
				// Only `secret: true` is a secret, the way buildVariableOrigins reads it.
				loose: { value: "not-a-secret", secret: "true", enabled: true },
			},
		},
	];

	test("list_environments withholds a secret value by default", async () => {
		const client = fakeClient({ listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS) });
		const { text, body } = await read("list_environments", client);
		expect(text).not.toContain("sk-live-123");
		expect(body[0].variables.apiKey).toEqual({
			secret: true,
			enabled: true,
			valueWithheld: true,
		});
		expect(body[0].variables.baseUrl.value).toBe("https://staging.test");
		expect(body[0].variables.loose.value).toBe("not-a-secret");
		expect(body[0].isActive).toBe(true);
	});

	test("list_environments returns the secret value with reveal on", async () => {
		const client = fakeClient({ listEnvironments: vi.fn().mockResolvedValue(ENVIRONMENTS) });
		const { body } = await read("list_environments", client, REVEAL);
		expect(body).toEqual(ENVIRONMENTS);
	});

	test("get_globals withholds a secret value unless revealed", async () => {
		const globals = {
			id: "globals",
			variables: { token: { value: "g-secret", secret: true, enabled: true } },
		};
		const client = fakeClient({ getGlobals: vi.fn().mockResolvedValue(globals) });
		const withheld = await read("get_globals", client);
		expect(withheld.text).not.toContain("g-secret");
		expect(withheld.body.variables.token.valueWithheld).toBe(true);
		expect((await read("get_globals", client, REVEAL)).body).toEqual(globals);
	});

	const REQUESTS = [
		{
			id: "req_1",
			name: "Me",
			auth: { mode: "bearer", token: "eyJ.live.token" },
		},
		{
			id: "req_2",
			name: "Referenced",
			auth: { mode: "bearer", token: "{{apiToken}}" },
		},
		{
			id: "req_3",
			name: "Machine",
			auth: {
				mode: "oauth2",
				config: {
					grantType: "client_credentials",
					accessTokenUrl: "https://auth.test/token",
					clientId: "app",
					clientSecret: "cs-123",
				},
			},
		},
		{
			id: "req_4",
			name: "Key",
			auth: { mode: "apikey", key: "X-Api-Key", value: "k-456", in: "header" },
		},
	];

	test("list_requests withholds auth credentials and keeps what describes them", async () => {
		const client = fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) });
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["eyJ.live.token", "cs-123", "k-456"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth).toEqual({ mode: "bearer", tokenWithheld: true });
		// A reference names where the secret lives without being it.
		expect(body[1].auth).toEqual({ mode: "bearer", token: "{{apiToken}}" });
		expect(body[2].auth.config).toEqual({
			grantType: "client_credentials",
			accessTokenUrl: "https://auth.test/token",
			clientId: "app",
			clientSecretWithheld: true,
		});
		expect(body[3].auth).toEqual({
			mode: "apikey",
			key: "X-Api-Key",
			valueWithheld: true,
			in: "header",
		});
	});

	test("list_requests returns auth whole with reveal on", async () => {
		const client = fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) });
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(REQUESTS);
	});

	test("get_request withholds one row's credentials exactly as list_requests does", async () => {
		const client = fakeClient({
			getRequest: vi.fn(async (id: string) => REQUESTS.find((row) => row.id === id)),
		});
		const { text, body } = await read("get_request", client, undefined, { requestId: "req_3" });
		expect(text).not.toContain("cs-123");
		expect(body.auth.config.clientSecretWithheld).toBe(true);
		expect(client.getRequest).toHaveBeenCalledWith("req_3", undefined);

		const listed = await readFull(
			"list_requests",
			fakeClient({ listRequestsPage: vi.fn().mockResolvedValue(page(REQUESTS)) }),
			undefined,
			{ collectionId: "c1" }
		);
		expect(body).toEqual(listed.body[2]);
	});

	test("get_request returns the row as stored with reveal on", async () => {
		const client = fakeClient({ getRequest: vi.fn().mockResolvedValue(REQUESTS[0]) });
		const { body } = await read("get_request", client, REVEAL, { requestId: "req_1" });
		expect(body).toEqual(REQUESTS[0]);
	});

	test("get_request answers an unknown id as an error naming the id", async () => {
		const client = fakeClient({
			getRequest: vi
				.fn()
				.mockRejectedValue(
					new EngineRequestError("Engine responded 404", 404, "Request not found")
				),
		});
		const res = await dispatchTool("get_request", { requestId: "req_gone" }, ctxWith(client));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain('No request with id "req_gone"');
	});

	test.each([{}, { requestId: "" }])(
		"get_request refuses %j before the engine is called",
		async (args) => {
			const client = fakeClient();
			const res = await dispatchTool("get_request", args, ctxWith(client));
			expect(res.isError).toBe(true);
			expect(firstText(res)).toMatch(/requestId.*required/i);
			expect(client.getRequest).not.toHaveBeenCalled();
		}
	);

	test("get_request is a read tool carrying read-only annotations", () => {
		const tool = TOOLS.find((t) => t.name === "get_request");
		expect(tool?.category).toBe("read");
		expect(tool?.invalidates).toEqual([]);
		expect(tool?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	test("list_collections withholds a collection's secret variables and auth", async () => {
		const collections = [
			{
				id: "c1",
				name: "API",
				variables: { pass: { value: "p@ss", secret: true } },
				auth: { mode: "basic", username: "me", password: "hunter2" },
			},
		];
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page(collections)),
		});
		const withheld = await readFull("list_collections", client);
		expect(withheld.text).not.toContain("p@ss");
		expect(withheld.text).not.toContain("hunter2");
		expect(withheld.body[0].auth).toEqual({
			mode: "basic",
			username: "me",
			passwordWithheld: true,
		});
		const revealed = await readFull("list_collections", client, REVEAL);
		expect(revealed.body[0].auth.password).toBe("hunter2");
		expect(revealed.body[0].variables.pass.value).toBe("p@ss");
	});

	const COOKIES = [
		{
			environmentId: null,
			name: "session",
			value: "abc123",
			domain: "x.test",
			path: "/",
			secure: true,
			httpOnly: true,
			expires: 1_900_000_000,
		},
	];

	test("get_cookies withholds every cookie value in full rows unless revealed", async () => {
		const client = fakeClient({ getCookiesPage: vi.fn().mockResolvedValue(page(COOKIES)) });
		const withheld = await readFull("get_cookies", client);
		expect(withheld.text).not.toContain("abc123");
		const { value: _value, ...described } = COOKIES[0];
		expect(withheld.body[0]).toEqual({ ...described, valueWithheld: true });
		expect((await readFull("get_cookies", client, REVEAL)).body).toEqual(COOKIES);
	});

	test.each([{}, REVEAL])(
		"a get_cookies summary row never carries a value (%j)",
		async (safety) => {
			const client = fakeClient({ getCookiesPage: vi.fn().mockResolvedValue(page(COOKIES)) });
			const { text, body } = await read("get_cookies", client, safety);
			expect(text).not.toContain("abc123");
			expect(body.data).toEqual([
				{
					environmentId: null,
					name: "session",
					domain: "x.test",
					path: "/",
					expires: 1_900_000_000,
				},
			]);
		}
	);

	const CONFIG = {
		entries: [
			{ key: "proxyMode", value: "manual" },
			{ key: "proxyUrl", value: "http://alice:pa@ss/w0rd@proxy.corp:8080" },
			{ key: "proxySystemUrl", value: "socks5h://bob:pw@sys.proxy:1080" },
			{ key: "proxyBypass", value: ".internal.test" },
			{ key: "workers", value: "8" },
		],
	};

	test("get_engine_config strips proxy URL credentials and keeps the host", async () => {
		const client = fakeClient({ getConfig: vi.fn().mockResolvedValue(CONFIG) });
		const { text, body } = await read("get_engine_config", client);
		for (const secret of ["alice", "pa@ss", "w0rd", "bob", ":pw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.entries[1]).toEqual({
			key: "proxyUrl",
			value: "http://proxy.corp:8080",
			credentialsWithheld: true,
		});
		expect(body.entries[2].value).toBe("socks5h://sys.proxy:1080");
		expect(body.entries[0]).toEqual(CONFIG.entries[0]);
		expect(body.entries[3]).toEqual(CONFIG.entries[3]);
		expect(body.entries[4]).toEqual(CONFIG.entries[4]);
	});

	test("get_engine_config returns proxy credentials with reveal on", async () => {
		const client = fakeClient({ getConfig: vi.fn().mockResolvedValue(CONFIG) });
		expect((await read("get_engine_config", client, REVEAL)).body).toEqual(CONFIG);
	});

	const DIAGNOSIS = {
		url: "https://api.example.com/",
		outcome: "proxy_failed",
		errorCode: "PROXY_ERROR",
		proxy: { mode: "manual", url: "http://alice:pa@ss/w0rd@proxy.corp:8080" },
		clientCertificate: "",
	};

	test("diagnose_connection strips the proxy URL's credentials and keeps the host", async () => {
		const client = fakeClient({ diagnoseConnection: vi.fn().mockResolvedValue(DIAGNOSIS) });
		const { text, body } = await read("diagnose_connection", client, ALLOW_API, {
			url: "https://api.example.com/",
		});
		for (const secret of ["alice", "pa@ss", "w0rd"]) {
			expect(text).not.toContain(secret);
		}
		expect(body.proxy).toEqual({
			mode: "manual",
			url: "http://proxy.corp:8080",
			credentialsWithheld: true,
		});
		expect(body.outcome).toBe("proxy_failed");
	});

	test("diagnose_connection returns the proxy URL as the engine reported it with reveal on", async () => {
		const client = fakeClient({ diagnoseConnection: vi.fn().mockResolvedValue(DIAGNOSIS) });
		const { body } = await read(
			"diagnose_connection",
			client,
			{ ...ALLOW_API, ...REVEAL },
			{ url: "https://api.example.com/" }
		);
		expect(body).toEqual(DIAGNOSIS);
	});

	test("update_engine_config's echo of the config table withholds the same credentials", async () => {
		const client = fakeClient({
			updateConfig: vi.fn().mockResolvedValue({ ...CONFIG, success: true }),
		});
		const res = await dispatchTool(
			"update_engine_config",
			{ entries: { workers: "8" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		expect(JSON.stringify(res)).not.toContain("alice");
		const out = res.structuredContent as { updated: typeof CONFIG };
		expect(out.updated.entries[1].value).toBe("http://proxy.corp:8080");
	});

	test("resolve_variables reports a secret's value with reveal on", async () => {
		const client = fakeClient({
			getGlobals: vi.fn().mockResolvedValue({
				variables: { token: { value: "s3cret", enabled: true, secret: true } },
			}),
		});
		const { body } = await read("resolve_variables", client, REVEAL);
		const token = body.variables.find((v: { name: string }) => v.name === "token");
		expect(token.value).toBe("s3cret");
		expect(token).not.toHaveProperty("valueWithheld");
	});

	test("an auth block read with its credentials withheld is refused as an argument", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", auth: { mode: "bearer", tokenWithheld: true } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("tokenWithheld");
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("so is one whose withheld credential sat under config", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{ name: "API", auth: { mode: "oauth2", config: { clientSecretWithheld: true } } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("clientSecretWithheld");
		expect(client.createCollection).not.toHaveBeenCalled();
	});

	// A Postman import keeps the auth as Postman wrote it under `postman`, raw
	// credentials included: the engine's `redact_postman_auth` is the rule.
	const POSTMAN_REQUESTS = [
		{
			id: "req_pm1",
			name: "Imported bearer",
			auth: {
				mode: "bearer",
				token: "{{tok}}",
				postman: {
					type: "bearer",
					bearer: [{ key: "token", value: "pm-bearer-raw", type: "string" }],
				},
			},
		},
		{
			id: "req_pm2",
			name: "Imported OAuth 2.0",
			auth: {
				mode: "oauth2",
				config: { grantType: "client_credentials", clientId: "app" },
				postman: {
					type: "oauth2",
					oauth2: [
						{ key: "clientSecret", value: "pm-cs-raw", type: "string" },
						{ key: "clientId", value: "app", type: "string" },
						{ key: "accessToken", value: "{{seeded}}", type: "string" },
						{
							key: "tokenRequestParams",
							value: [
								{ key: "client_secret", value: "pm-param-raw", enabled: true },
								{ key: "audience", value: "api", enabled: true },
							],
							type: "any",
						},
					],
				},
			},
		},
	];

	test("list_requests withholds the credentials in a Postman import's source", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(POSTMAN_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["pm-bearer-raw", "pm-cs-raw", "pm-param-raw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.postman.bearer).toEqual([
			{ key: "token", type: "string", valueWithheld: true },
		]);
		expect(body[1].auth.postman.oauth2).toEqual([
			{ key: "clientSecret", type: "string", valueWithheld: true },
			{ key: "clientId", value: "app", type: "string" },
			{ key: "accessToken", value: "{{seeded}}", type: "string" },
			{
				key: "tokenRequestParams",
				value: [
					{ key: "client_secret", enabled: true, valueWithheld: true },
					{ key: "audience", value: "api", enabled: true },
				],
				type: "any",
			},
		]);
	});

	test("list_requests returns a Postman import's source whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(POSTMAN_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(POSTMAN_REQUESTS);
	});

	test("list_collections withholds a v2.0 Postman source's credentials unless revealed", async () => {
		const collections = [
			{
				id: "c1",
				name: "API",
				auth: {
					mode: "oauth2",
					config: { grantType: "client_credentials", clientId: "app" },
					postman: {
						type: "oauth2",
						oauth2: {
							clientId: "app",
							clientSecret: "pm-v20-raw",
							refreshRequestParams: [{ key: "refresh_token", value: "pm-rt-raw" }],
						},
					},
				},
			},
		];
		const client = fakeClient({
			listCollectionsPage: vi.fn().mockResolvedValue(page(collections)),
		});
		const withheld = await readFull("list_collections", client);
		expect(withheld.text).not.toContain("pm-v20-raw");
		expect(withheld.text).not.toContain("pm-rt-raw");
		expect(withheld.body[0].auth.postman).toEqual({
			type: "oauth2",
			oauth2: {
				clientId: "app",
				clientSecretWithheld: true,
				refreshRequestParams: [{ key: "refresh_token", valueWithheld: true }],
			},
		});
		const revealed = await readFull("list_collections", client, REVEAL);
		expect(revealed.body[0].auth.postman).toEqual(collections[0].auth.postman);
	});

	test("an auth argument whose Postman source was read withheld is refused", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_pm2",
				auth: {
					mode: "oauth2",
					postman: {
						type: "oauth2",
						oauth2: [
							{
								key: "tokenRequestParams",
								value: [{ key: "client_secret", valueWithheld: true }],
							},
						],
					},
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(
			"postman.oauth2[tokenRequestParams][client_secret].valueWithheld"
		);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	test("so is one whose v2.0 Postman source carries a withheld member", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_collection",
			{
				name: "API",
				auth: {
					mode: "bearer",
					postman: { type: "bearer", bearer: { tokenWithheld: true } },
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("postman.bearer.tokenWithheld");
		expect(client.createCollection).not.toHaveBeenCalled();
	});

	// An OAuth 2.0 config's extra request parameter lists (#2536): redacted per
	// row, so the key, `enabled` and `sendAs` stay and only a credential's value
	// goes. A row can be sent as a header, so the header names count too.
	const CONFIG_PARAM_REQUEST = {
		id: "req_cfg",
		name: "OAuth 2.0 with extra parameters",
		auth: {
			mode: "oauth2",
			config: {
				grantType: "authorization_code",
				clientId: "app",
				authorizationParams: [
					{ key: "api_key", value: "cfg-q-raw", enabled: true },
					{ key: "prompt", value: "login", enabled: true },
				],
				tokenParams: [
					{ key: "client_secret", value: "cfg-body-raw", enabled: true, sendAs: "body" },
					{
						key: "Authorization",
						value: "cfg-hdr-raw",
						enabled: false,
						sendAs: "header",
					},
					{ key: "audience", value: "api", enabled: true, sendAs: "url" },
				],
				refreshParams: [
					{ key: "refresh_token", value: "{{rt}}", enabled: true },
					{ key: "assertion", value: "cfg-assert-raw", enabled: true },
				],
			},
		},
	};

	test("list_requests withholds a credential-named extra parameter's value, row by row", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page([CONFIG_PARAM_REQUEST])),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of ["cfg-q-raw", "cfg-body-raw", "cfg-hdr-raw", "cfg-assert-raw"]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.config).toEqual({
			grantType: "authorization_code",
			clientId: "app",
			authorizationParams: [
				{ key: "api_key", enabled: true, valueWithheld: true },
				{ key: "prompt", value: "login", enabled: true },
			],
			tokenParams: [
				{ key: "client_secret", enabled: true, sendAs: "body", valueWithheld: true },
				{ key: "Authorization", enabled: false, sendAs: "header", valueWithheld: true },
				{ key: "audience", value: "api", enabled: true, sendAs: "url" },
			],
			refreshParams: [
				{ key: "refresh_token", value: "{{rt}}", enabled: true },
				{ key: "assertion", enabled: true, valueWithheld: true },
			],
		});
	});

	test("list_requests returns the extra parameter rows whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page([CONFIG_PARAM_REQUEST])),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual([CONFIG_PARAM_REQUEST]);
	});

	test("an auth argument whose extra parameter row was read withheld is refused", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_cfg",
				auth: {
					mode: "oauth2",
					config: {
						tokenParams: [{ key: "client_secret", enabled: true, valueWithheld: true }],
					},
				},
			},
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain("config.tokenParams[client_secret].valueWithheld");
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	// A row the engine's export would blank whole - no key, or a member no row
	// has - is withheld here too, not passed through because its key names no
	// credential. Mutation check: withhold only a credential-named row's
	// `value` and the secrets below reach the agent.
	test("list_requests withholds an extra parameter row with no key, or a member no row has", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(
				page([
					{
						id: "req_odd",
						auth: {
							mode: "oauth2",
							config: {
								tokenParams: [
									{ value: "odd-keyless-raw" },
									{ keyy: "client_secret", value: "odd-misspelt-raw" },
									{ key: "audience", value: "api", note: "odd-note-raw" },
								],
								refreshParams: "refresh_token=odd-list-raw",
							},
						},
					},
				])
			),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"odd-keyless-raw",
			"odd-misspelt-raw",
			"odd-note-raw",
			"odd-list-raw",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].auth.config).toEqual({
			tokenParams: [
				{ valueWithheld: true },
				{ valueWithheld: true },
				{ key: "audience", value: "api", noteWithheld: true },
			],
			refreshParamsWithheld: true,
		});
	});

	test.each([
		[
			"a keyless row",
			{ tokenParams: [{ valueWithheld: true }] },
			"config.tokenParams[0].valueWithheld",
		],
		[
			"a row's other member",
			{ tokenParams: [{ key: "audience", value: "api", noteWithheld: true }] },
			"config.tokenParams[audience].noteWithheld",
		],
		["a whole list", { refreshParamsWithheld: true }, "config.refreshParamsWithheld"],
	])("an auth argument carrying %s read withheld is refused", async (_, config, marker) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_cfg", auth: { mode: "oauth2", config } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toContain(marker);
		expect(client.updateRequest).not.toHaveBeenCalled();
	});

	// A header typed straight into the Headers tab is no variable: its name is
	// the only signal, and the shared list plus the request's API-key header
	// decide (#1809).
	const HEADER_REQUESTS = [
		{
			id: "req_h1",
			name: "Typed credentials",
			auth: { mode: "none" },
			headers: [
				{ key: "Authorization", value: "Bearer typed-live-token", enabled: true },
				{ key: "cookie", value: "sid=typed-cookie", enabled: false },
				{ key: "X-Api-Key", value: "{{apiKey}}", enabled: true },
				{ key: "X-Auth-Token", value: "", enabled: true },
				{ key: "Content-Type", value: "application/json", enabled: true },
			],
		},
		{
			id: "req_h2",
			name: "API-key auth names its header",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "header" },
			headers: [{ key: "x-tenant-key", value: "typed-tenant-key", enabled: true }],
		},
		{
			id: "req_h3",
			name: "API-key auth in the query",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "query" },
			headers: [{ key: "X-Tenant-Key", value: "typed-query-tenant", enabled: true }],
		},
	];

	test("list_requests withholds a credential-bearing header's value and keeps the row", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(HEADER_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"typed-live-token",
			"typed-cookie",
			"typed-tenant-key",
			"typed-query-tenant",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].headers).toEqual([
			{ key: "Authorization", enabled: true, valueWithheld: true },
			{ key: "cookie", enabled: false, valueWithheld: true },
			// A reference names where the secret lives without being it, and an
			// empty value holds none.
			{ key: "X-Api-Key", value: "{{apiKey}}", enabled: true },
			{ key: "X-Auth-Token", value: "", enabled: true },
			{ key: "Content-Type", value: "application/json", enabled: true },
		]);
		expect(body[1].headers).toEqual([
			{ key: "x-tenant-key", enabled: true, valueWithheld: true },
		]);
		// The engine names the API-key header whatever `in` says, so a header row
		// under that name is withheld beside a query-placed key too.
		expect(body[2].headers).toEqual([
			{ key: "X-Tenant-Key", enabled: true, valueWithheld: true },
		]);
	});

	test("list_requests returns every header whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(HEADER_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(HEADER_REQUESTS);
	});

	// A credential written into the URL or the Params table is no variable
	// either: the name decides, in the URL as in the rows (#1837).
	const URL_REQUESTS = [
		{
			id: "req_u1",
			name: "Credentials in the URL",
			auth: { mode: "none" },
			url: "https://typed-user:typed-password@api.example.com/x?api_key=typed-api-key&page=2&token={{token}}#access_token=typed-fragment-token",
			params: [
				{ key: "api_key", value: "typed-api-key", enabled: true },
				{ key: "page", value: "2", enabled: true },
				{ key: "TOKEN", value: "typed-disabled-token", enabled: false },
				{ key: "signature", value: "{{signature}}", enabled: true },
				{ key: "code", value: "US", enabled: true },
			],
		},
		{
			id: "req_u2",
			name: "API-key auth in the query",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "query" },
			url: "https://api.example.com/x?x-tenant-key=typed-tenant-key&code=US",
			params: [{ key: "x-tenant-KEY", value: "typed-tenant-key", enabled: true }],
		},
		{
			id: "req_u3",
			name: "API-key auth in a header does not name a query parameter",
			auth: { mode: "apikey", key: "X-Tenant-Key", value: "{{tenantKey}}", in: "header" },
			url: "https://api.example.com/x?x-tenant-key=kept",
			params: [{ key: "x-tenant-key", value: "kept", enabled: true }],
		},
		{ id: "req_u4", name: "Not a string", auth: { mode: "none" }, url: null, params: "none" },
	];

	test("list_requests drops a URL's password and credential query values and withholds the Params rows", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(URL_REQUESTS)),
		});
		const { text, body } = await readFull("list_requests", client, undefined, {
			collectionId: "c1",
		});
		for (const secret of [
			"typed-password",
			"typed-api-key",
			"typed-fragment-token",
			"typed-disabled-token",
			"typed-tenant-key",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(body[0].url).toBe(
			"https://typed-user@api.example.com/x?api_key=&page=2&token={{token}}#access_token="
		);
		expect(body[0].params).toEqual([
			{ key: "api_key", enabled: true, valueWithheld: true },
			{ key: "page", value: "2", enabled: true },
			{ key: "TOKEN", enabled: false, valueWithheld: true },
			{ key: "signature", value: "{{signature}}", enabled: true },
			{ key: "code", value: "US", enabled: true },
		]);
		expect(body[1].url).toBe("https://api.example.com/x?x-tenant-key=&code=US");
		expect(body[1].params).toEqual([
			{ key: "x-tenant-KEY", enabled: true, valueWithheld: true },
		]);
		expect(body[2].url).toBe(URL_REQUESTS[2].url);
		expect(body[2].params).toEqual(URL_REQUESTS[2].params);
		expect(body[3]).toEqual(URL_REQUESTS[3]);
	});

	test("list_requests returns every URL and Params row whole with reveal on", async () => {
		const client = fakeClient({
			listRequestsPage: vi.fn().mockResolvedValue(page(URL_REQUESTS)),
		});
		const { body } = await readFull("list_requests", client, REVEAL, { collectionId: "c1" });
		expect(body).toEqual(URL_REQUESTS);
	});

	// The preview is read by the agent and the prompt by a person, and the URL
	// is in both.
	const deletePreview = async (safety: Partial<McpSafetyConfig>) => {
		const client = fakeClient({
			getRequest: vi.fn().mockResolvedValue({
				id: "req_1",
				name: "Get users",
				method: "GET",
				url: "https://typed-user:typed-password@api.example.com/users?api_key=typed-api-key&page=2",
				auth: { mode: "none" },
			}),
		});
		const unprompted = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxWith(client, { allowWrites: true, ...safety })
		);
		const asked = await dispatchTool(
			"delete_request",
			{ requestId: "req_1" },
			ctxAsking(client, { allowWrites: true, ...safety })
		);
		return { preview: firstText(unprompted), prompt: askedQuestion(asked) };
	};

	test("delete_request names the URL in its preview and prompt without the password or the credential values", async () => {
		const { preview, prompt } = await deletePreview({});
		for (const text of [preview, prompt]) {
			expect(text).toContain("GET https://typed-user@api.example.com/users?api_key=&page=2");
			expect(text).not.toContain("typed-password");
			expect(text).not.toContain("typed-api-key");
		}
	});

	test("delete_request names the URL as stored with reveal on", async () => {
		const { preview, prompt } = await deletePreview(REVEAL);
		for (const text of [preview, prompt]) {
			expect(text).toContain(
				"https://typed-user:typed-password@api.example.com/users?api_key=typed-api-key&page=2"
			);
		}
	});

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
			args: { id: "c1" },
			method: "restoreTrashEntry",
			answer: { id: "c1", kind: "collection", restored: true, auth: ECHO_COLLECTION.auth },
			secrets: ["echo-collection-token"],
		},
		{
			tool: "move_item",
			args: { type: "request", id: "req_1", collectionId: "c1" },
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
		expect(text).toMatch(/Withheld": true/);
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

	// What a run recorded carries the secrets it sent, in whatever encoding they
	// went out in, and the credential headers on both sides of the exchange: the
	// engine's snapshot rule masks them in place (#1809).
	const RUN_SECRET = 'p@ss "w/rd"&x';
	/** Each of `RUN_SECRET`'s forms holds one of these, so their absence is every form's. */
	const RUN_SECRET_CORES = ["p@ss", "p%40ss"];
	const RUN_LEAKS = [
		...RUN_SECRET_CORES,
		"glob-secret-1",
		"col-secret-9",
		"typed-bearer-token",
		"resp-cookie-value",
		"theme=dark",
		"req-typed-key",
		"tenant-typed-key",
	];
	const PERCENT_FORM = "p%40ss%20%22w%2Frd%22%26x";
	const QUERY_FORM = "p@ss%20%22w/rd%22%26x";
	const XML_FORM = 'p@ss "w/rd"&amp;x';

	/** The reads `runOutputShape` makes, holding one secret per scope. */
	const runScopes = () => ({
		getGlobals: vi.fn().mockResolvedValue({
			id: "globals",
			variables: { gtok: { value: "glob-secret-1", secret: true, enabled: true } },
		}),
		listEnvironments: vi.fn().mockResolvedValue([
			{
				id: "env_1",
				variables: {
					pass: { value: RUN_SECRET, secret: true, enabled: true },
					// Under the engine's four-byte floor: masked nowhere.
					short: { value: "abc", secret: true, enabled: true },
					plain: { value: "visible-value", enabled: true },
				},
			},
		]),
		listCollections: vi.fn().mockResolvedValue([
			{
				id: "c1",
				variables: { ck: { value: "col-secret-9", secret: true } },
				auth: { mode: "apikey", key: "X-Tenant-Key", in: "header" },
			},
		]),
		listAllRequests: vi
			.fn()
			.mockResolvedValue([
				{ id: "r1", auth: { mode: "apikey", key: "X-Req-Key", value: "v", in: "header" } },
			]),
	});

	/** One trace node pair as `build_result_trace` stores it, every form of every secret on it. */
	const RUN_TRACE = {
		request: {
			method: "POST",
			url: `https://api.example.com/v1?key=${QUERY_FORM}&abc=1&plain=visible-value`,
			headers: {
				Authorization: "Bearer typed-bearer-token",
				"X-Tenant-Key": "tenant-typed-key",
				"X-Echo": "glob-secret-1",
				Accept: "*/*",
			},
			body: JSON.stringify({ password: RUN_SECRET, region: "eu" }),
			rawRequest:
				`POST /v1?key=${PERCENT_FORM} HTTP/1.1\r\nHost: api.example.com\r\n` +
				"Authorization: Bearer typed-bearer-token\r\nX-Req-Key: req-typed-key\r\n" +
				"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
				`<login pw="${XML_FORM}">col-secret-9</login>`,
		},
		response: {
			headers: {
				"Set-Cookie": "sid=resp-cookie-value; HttpOnly",
				"Content-Type": "application/json",
			},
			// The rows as received (#2460): the Set-Cookie the map folds is a row each.
			headerLines: [
				{ name: "Set-Cookie", value: "sid=resp-cookie-value; HttpOnly" },
				{ name: "Content-Type", value: "application/json" },
				{ name: "set-cookie", value: "theme=dark" },
			],
			body: JSON.stringify({ echo: RUN_SECRET }),
			bodyBytes: 4321,
		},
	};

	const runClient = (overrides: Partial<Record<keyof EngineClient, unknown>>) =>
		fakeClient({ ...runScopes(), ...overrides });

	function expectRunOutputWithheld(text: string) {
		for (const leak of RUN_LEAKS) expect(text, leak).not.toContain(leak);
		expect(text).toContain("<redacted>");
	}

	/** A trace node pair after the mask: every value gone, every name, order and size kept. */
	function expectTraceMasked(trace: typeof RUN_TRACE) {
		expect(trace.request.url).toBe(
			"https://api.example.com/v1?key=<redacted>&abc=1&plain=visible-value"
		);
		expect(trace.request.headers).toEqual({
			Authorization: "<redacted>",
			"X-Tenant-Key": "<redacted>",
			"X-Echo": "<redacted>",
			Accept: "*/*",
		});
		expect(JSON.parse(trace.request.body)).toEqual({ password: "<redacted>", region: "eu" });
		expect(trace.request.rawRequest).toBe(
			"POST /v1?key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"Authorization: <redacted>\r\nX-Req-Key: <redacted>\r\n" +
				"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
				'<login pw="<redacted>"><redacted></login>'
		);
		expect(trace.response.headers).toEqual({
			"Set-Cookie": "<redacted>",
			"Content-Type": "application/json",
		});
		expect(trace.response.headerLines).toEqual([
			{ name: "Set-Cookie", value: "<redacted>" },
			{ name: "Content-Type", value: "application/json" },
			{ name: "set-cookie", value: "<redacted>" },
		]);
		expect(JSON.parse(trace.response.body)).toEqual({ echo: "<redacted>" });
		expect(trace.response.bodyBytes).toBe(4321);
	}

	const EXECUTE_ANSWER = {
		status: 200,
		headers: RUN_TRACE.response.headers,
		headerLines: RUN_TRACE.response.headerLines,
		requestHeaders: RUN_TRACE.request.headers,
		rawRequest: RUN_TRACE.request.rawRequest,
		body: { echo: RUN_SECRET },
		bodyRaw: RUN_TRACE.response.body,
		bodySize: 4321,
		bodyCapped: false,
	};

	const sendRequest = (client: EngineClient, safety: Partial<McpSafetyConfig> = {}) =>
		read(
			"run_request",
			client,
			{ ...ALLOW_API, ...safety },
			{
				url: "https://api.example.com/v1",
			}
		);

	test("run_request masks every secret form and credential header in the exchange", async () => {
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		const { text, body } = await sendRequest(client);
		expectRunOutputWithheld(text);
		expect(body).toEqual({
			status: 200,
			headers: { "Set-Cookie": "<redacted>", "Content-Type": "application/json" },
			headerLines: [
				{ name: "Set-Cookie", value: "<redacted>" },
				{ name: "Content-Type", value: "application/json" },
				{ name: "set-cookie", value: "<redacted>" },
			],
			requestHeaders: {
				Authorization: "<redacted>",
				"X-Tenant-Key": "<redacted>",
				"X-Echo": "<redacted>",
				Accept: "*/*",
			},
			rawRequest:
				"POST /v1?key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"Authorization: <redacted>\r\nX-Req-Key: <redacted>\r\n" +
				"Cookie: {{session}}\r\nAccept: */*\r\n\r\n" +
				'<login pw="<redacted>"><redacted></login>',
			body: { echo: "<redacted>" },
			bodyRaw: '{"echo":"<redacted>"}',
			bodySize: 4321,
			bodyCapped: false,
		});
	});

	test("run_request masks credential lines in requestHeaderLines, every repeat, keeping names and order (#2466)", async () => {
		// Mutation check: match only `headers` / `headerLines` and these lines
		// read back verbatim.
		const lines = [
			{ name: "Authorization", value: "Bearer typed-bearer-token" },
			{ name: "authorization", value: "Bearer second-typed-token" },
			{ name: "Cookie", value: "sid=request-cookie-value" },
			{ name: "Cookie", value: "theme=dark" },
			{ name: "X-Api-Key", value: "api-key-line-value" },
			{ name: "X-Plain", value: "kept-one" },
			{ name: "X-Plain", value: "kept-two" },
		];
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({
				...EXECUTE_ANSWER,
				requestHeaderLines: lines,
			}),
		});
		const { text, body } = await sendRequest(client);
		expect(body.requestHeaderLines).toEqual([
			{ name: "Authorization", value: "<redacted>" },
			{ name: "authorization", value: "<redacted>" },
			{ name: "Cookie", value: "<redacted>" },
			{ name: "Cookie", value: "<redacted>" },
			{ name: "X-Api-Key", value: "<redacted>" },
			{ name: "X-Plain", value: "kept-one" },
			{ name: "X-Plain", value: "kept-two" },
		]);
		for (const leak of ["typed-bearer-token", "second-typed-token", "request-cookie-value"]) {
			expect(text).not.toContain(leak);
		}

		const revealed = await sendRequest(
			runClient({
				executeRequest: vi
					.fn()
					.mockResolvedValue({ ...EXECUTE_ANSWER, requestHeaderLines: lines }),
			}),
			REVEAL
		);
		expect(revealed.body.requestHeaderLines).toEqual(lines);
	});

	test("run_request passes a followed redirect through and masks the hop's Set-Cookie (#2461)", async () => {
		const hop = {
			status: 302,
			statusText: "Found",
			headerLines: [
				{ name: "Set-Cookie", value: "session=hop-cookie-value; Path=/" },
				{ name: "Location", value: "/home" },
			],
		};
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({ ...EXECUTE_ANSWER, redirects: [hop] }),
		});
		const { text, body } = await sendRequest(client);
		expect(text).not.toContain("hop-cookie-value");
		expect(body.redirects).toEqual([
			{
				status: 302,
				statusText: "Found",
				headerLines: [
					{ name: "Set-Cookie", value: "<redacted>" },
					{ name: "Location", value: "/home" },
				],
			},
		]);
	});

	test("run_request returns the exchange as the engine answered it with reveal on", async () => {
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		const { body } = await sendRequest(client, REVEAL);
		expect(body).toEqual(EXECUTE_ANSWER);
		// The identity costs nothing: no secret is read to build it.
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("run_request masks the query value and headers the live answer says auth wrote (#1845)", async () => {
		const TOKEN = "oauth-token-placed-by-the-engine-55";
		const SESSION = "session-header-value-66";
		const answer = {
			...EXECUTE_ANSWER,
			// The engine's `/execute` answer has no `url`: the request line in
			// `rawRequest` is the only place the placed token appears.
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			requestHeaders: { "X-Session": SESSION, Accept: "*/*" },
			rawRequest:
				`GET /v1?page=2&access_token=${TOKEN} HTTP/1.1\r\nHost: api.example.com\r\n` +
				`X-Session: ${SESSION}\r\n\r\n`,
		};
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
		const withheld = await sendRequest(client);
		expect(withheld.text).not.toContain(TOKEN);
		expect(withheld.text).not.toContain(SESSION);
		expect(withheld.body.authQueryParam).toBe("access_token");
		expect(withheld.body.requestHeaders).toEqual({ "X-Session": "<redacted>", Accept: "*/*" });
		expect(withheld.body.rawRequest).toBe(
			"GET /v1?page=2&access_token=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"X-Session: <redacted>\r\n\r\n"
		);
		const revealed = await sendRequest(client, REVEAL);
		expect(revealed.body).toEqual(answer);
	});

	test("run_request passes the engine's authNotice through, masked or revealed (#2474)", async () => {
		// The agent that sees a 401 from a request whose auth mode is not
		// executed is the reader who most needs to be told it was never sent.
		const NOTICE =
			"auth mode 'ntlm' is not executed by Vayu; the request was sent without authentication";
		const answer = { ...EXECUTE_ANSWER, status: 401, authNotice: NOTICE };
		const client = runClient({ executeRequest: vi.fn().mockResolvedValue(answer) });
		const withheld = await sendRequest(client);
		expect(withheld.body.authNotice).toBe(NOTICE);
		const revealed = await sendRequest(client, REVEAL);
		expect(revealed.body.authNotice).toBe(NOTICE);
		// A response without the key stays without it, so the pass-through adds no
		// empty field for an executed mode.
		const plain = runClient({ executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER) });
		expect("authNotice" in (await sendRequest(plain)).body).toBe(false);
	});

	test("run_request masks the header an inline API-key auth names", async () => {
		const client = runClient({
			executeRequest: vi.fn().mockResolvedValue({
				...EXECUTE_ANSWER,
				requestHeaders: { "X-Inline-Key": "inline-typed-key" },
			}),
		});
		const { text, body } = await read("run_request", client, ALLOW_API, {
			url: "https://api.example.com/v1",
			auth: { mode: "apikey", key: "X-Inline-Key", value: "inline-typed-key", in: "header" },
		});
		expect(text).not.toContain("inline-typed-key");
		expect(body.requestHeaders).toEqual({ "X-Inline-Key": "<redacted>" });
	});

	test("run_request masks a streamed run's events unless revealed", async () => {
		const events = [{ event: "token", data: `{"t":"glob-secret-1","u":"${PERCENT_FORM}"}` }];
		const client = runClient({
			executeRequest: vi
				.fn()
				.mockResolvedValue({ runId: "run_s", eventsUrl: "/runs/run_s/events" }),
			consumeStreamEvents: vi
				.fn()
				.mockResolvedValue({ events, completed: true, capReached: false }),
		});
		const args = { url: "https://api.example.com/v1", stream: true };
		const withheld = await read("run_request", client, ALLOW_API, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.events).toEqual([
			{ event: "token", data: '{"t":"<redacted>","u":"<redacted>"}' },
		]);
		const revealed = await read("run_request", client, { ...ALLOW_API, ...REVEAL }, args);
		expect(revealed.body.events).toEqual(events);
	});

	const RUN_REPORT = {
		metadata: { runId: "run_1", requestUrl: `https://api.example.com/v1?key=${QUERY_FORM}` },
		summary: { totalRequests: 1 },
		results: [{ id: 1, statusCode: 200, trace: RUN_TRACE }],
	};

	test("get_run_report masks the stored trace and keeps its shape", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const { text, body } = await read("get_run_report", client, undefined, { runId: "run_1" });
		expectRunOutputWithheld(text);
		expectTraceMasked(body.results[0].trace);
		expect(body.metadata.requestUrl).toBe("https://api.example.com/v1?key=<redacted>");
		expect(body.summary).toEqual(RUN_REPORT.summary);
	});

	test("get_run_report returns the stored trace whole with reveal on", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const { body } = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(body).toEqual(RUN_REPORT);
	});

	test("get_run masks a secret in the snapshot fields it echoes unless revealed", async () => {
		// `duration` is echoed; the secret reaching it shows the mask runs before
		// the projection, so what the projection keeps cannot carry a secret.
		const row = {
			id: "run_1",
			type: "load",
			status: "running",
			startTime: 1_755_000_000_000,
			endTime: 1_755_000_000_000,
			configSnapshot: {
				url: `https://api.example.com/v1?key=${QUERY_FORM}`,
				mode: "constant_rps",
				duration: "glob-secret-1",
			},
		};
		const client = runClient({ getRun: vi.fn().mockResolvedValue(row) });
		const withheld = await read("get_run", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain("glob-secret-1");
		for (const leak of RUN_SECRET_CORES) expect(withheld.text).not.toContain(leak);
		expect(withheld.body.duration).toBe("<redacted>");
		expect(withheld.body.plannedDurationMs).toBeNull();
		const revealed = await read("get_run", client, REVEAL, { runId: "run_1" });
		expect(revealed.body.duration).toBe("glob-secret-1");
	});

	test("get_run_report masks before it cuts, so no prefix of a secret survives the cut", async () => {
		// The secret straddles the per-body cut: bounded first, its first three
		// bytes would be left behind where no form can match them.
		const body = "x".repeat(MAX_INLINE_BODY_BYTES - 3) + "col-secret-9" + "y".repeat(100);
		const report = { results: [{ id: 1, trace: { response: { body } } }] };
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(report) });
		const out = await read("get_run_report", client, undefined, { runId: "run_1" });
		const cut = out.body.results[0].trace.response;
		expect(cut.bodyTruncated).toBe(true);
		expect(cut.body.endsWith("<re")).toBe(true);
		expect(cut.body).not.toContain("col");
	});

	test("get_run_samples masks a sample's Set-Cookie and body unless revealed", async () => {
		const samples = page([
			{
				resultId: 1,
				response: {
					headers: {
						"set-cookie": "sid=resp-cookie-value",
						"content-type": "text/plain",
					},
					body: `token=glob-secret-1&p=${PERCENT_FORM}`,
					bodyBytes: 40,
				},
			},
		]);
		const client = runClient({ getRunSamples: vi.fn().mockResolvedValue(samples) });
		const withheld = await read("get_run_samples", client, undefined, { runId: "run_1" });
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0].response).toEqual({
			headers: { "set-cookie": "<redacted>", "content-type": "text/plain" },
			body: "token=<redacted>&p=<redacted>",
			bodyBytes: 40,
		});
		expect(withheld.body.pagination).toEqual(lastPageAnswer(samples).pagination);
		const revealed = await read("get_run_samples", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(lastPageAnswer(samples));
	});

	const RUN_ROW = {
		id: "run_1",
		type: "design",
		baseline: true,
		summary: {
			url: `https://api.example.com/v1?key=${PERCENT_FORM}`,
			comment: "after rotating col-secret-9",
			// The rows' file (issue #2051): a name and a digest, no secret in
			// either, so withholding passes both through.
			dataFileName: "users.csv",
			dataFileHash: "c".repeat(64),
			dataFileCastNumbers: true,
		},
	};

	test("list_runs masks a run row's summary unless revealed", async () => {
		const runs = page([RUN_ROW]);
		const client = runClient({ listRuns: vi.fn().mockResolvedValue(runs) });
		const withheld = await read("list_runs", client);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0].summary).toEqual({
			url: "https://api.example.com/v1?key=<redacted>",
			comment: "after rotating <redacted>",
			dataFileName: "users.csv",
			dataFileHash: "c".repeat(64),
			dataFileCastNumbers: true,
		});
		expect((await read("list_runs", client, REVEAL)).body).toEqual(lastPageAnswer(runs));
	});

	test("set_run_baseline masks the run row it echoes unless revealed", async () => {
		const client = runClient({ setRunBaseline: vi.fn().mockResolvedValue(RUN_ROW) });
		const args = { runId: "run_1", baseline: true };
		const withheld = await read("set_run_baseline", client, { allowWrites: true }, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.summary.url).toBe("https://api.example.com/v1?key=<redacted>");
		const revealed = await read(
			"set_run_baseline",
			client,
			{ allowWrites: true, ...REVEAL },
			args
		);
		expect(revealed.body).toEqual(RUN_ROW);
	});

	test("get_inbox_captures masks a capture's credential headers and secrets unless revealed", async () => {
		const captures = page([
			{
				id: 1,
				method: "POST",
				path: "/hook",
				query: `token=${QUERY_FORM}`,
				headers: { Authorization: "Bearer typed-bearer-token", "User-Agent": "sender/1" },
				body: JSON.stringify({ key: RUN_SECRET }),
				bodyBytes: 30,
				bodyTruncated: false,
			},
		]);
		const client = runClient({ getInboxCaptures: vi.fn().mockResolvedValue(captures) });
		const withheld = await read("get_inbox_captures", client, undefined, {
			inboxId: "inbox_1",
		});
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.data[0]).toMatchObject({
			query: "token=<redacted>",
			headers: { Authorization: "<redacted>", "User-Agent": "sender/1" },
			body: '{"key":"<redacted>"}',
			bodyBytes: 30,
		});
		const revealed = await read("get_inbox_captures", client, REVEAL, { inboxId: "inbox_1" });
		expect(revealed.body).toEqual(lastPageAnswer(captures));
	});

	test("get_mock_activity masks a secret in a logged path unless revealed", async () => {
		// The engine logs `req.path`, which cpp-httplib splits from the query, so a
		// query never reaches the log today; the by-value mask covers it all the same.
		const activity = {
			data: [
				{
					at_ms: 3,
					method: "GET",
					path: `/db/${PERCENT_FORM}`,
					status: 200,
					request_id: "r1",
				},
				{ at_ms: 2, method: "GET", path: `/x?token=${QUERY_FORM}`, status: 404 },
				{ at_ms: 1, method: "GET", path: "/db/glob-secret-1/ping", status: 501 },
				{ at_ms: 0, method: "POST", path: "/health", status: 200, injected_error: false },
			],
		};
		const client = runClient({ getMockServerActivity: vi.fn().mockResolvedValue(activity) });
		const withheld = await read("get_mock_activity", client, undefined, { mockId: "mock_1" });
		for (const leak of RUN_LEAKS) expect(withheld.text, leak).not.toContain(leak);
		expect(withheld.body.data).toEqual([
			{ ...activity.data[0], path: "/db/<redacted>" },
			{ ...activity.data[1], path: "/x?token=<redacted>" },
			{ ...activity.data[2], path: "/db/<redacted>/ping" },
			activity.data[3],
		]);
		const revealed = await read("get_mock_activity", client, REVEAL, { mockId: "mock_1" });
		expect(revealed.body).toEqual(activity);
	});

	test("a failed secret lookup fails the read closed, naming the lookup and returning nothing", async () => {
		const client = runClient({
			getGlobals: vi.fn().mockRejectedValue(new Error("engine hiccup")),
			getRunReport: vi.fn().mockResolvedValue(RUN_REPORT),
		});
		const res = await dispatchTool("get_run_report", { runId: "run_1" }, ctxWith(client));
		expect(res.isError).toBe(true);
		const text = firstText(res);
		expect(text).toMatch(/masking .* could not complete, because the globals lookup/);
		expect(text).toContain("engine hiccup");
		// None of the report, masked or not: the other reads answered, but a
		// partly masked record is the leak this refuses.
		expect(text).not.toContain("api.example.com");
		for (const leak of RUN_LEAKS) expect(text, leak).not.toContain(leak);
		expect(res.content).toHaveLength(1);

		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(RUN_REPORT);
	});

	/*
	 * With the engine down the masking lookup is the first thing to fail, but the
	 * outage is the news: a Reveal secrets setting must never read as its remedy
	 * (#2780).
	 */
	describe("a failed secret lookup is worded by its cause", () => {
		const failWith = (cause: unknown) =>
			dispatchTool(
				"list_runs",
				{},
				ctxWith(runClient({ getGlobals: vi.fn().mockRejectedValue(cause) }))
			);

		test("an engine that is down leads with the outage, not the setting", async () => {
			const res = await failWith(new TypeError("fetch failed"));
			const text = firstText(res);
			expect(text.startsWith("Could not reach the Vayu engine")).toBe(true);
			expect(text).toContain("withheld whole");
			expect(text).not.toMatch(/Reveal secrets/i);
			expect(res.structuredContent).toMatchObject({
				error: { class: "unreachable", retryable: true },
			});
		});

		test("an engine that answered 5xx leads with its answer and stays transient", async () => {
			const res = await failWith(
				new EngineRequestError("Engine responded 500 for GET /globals", 500, "boom")
			);
			const text = firstText(res);
			expect(text.startsWith("Engine error (500)")).toBe(true);
			expect(text).toContain("withheld whole");
			expect(text).not.toMatch(/Reveal secrets/i);
			expect(res.structuredContent).toMatchObject({ error: { class: "transient" } });
		});

		test.each([
			["a cause that says nothing about the engine", new Error("engine hiccup")],
			["an engine refusal of the lookup itself", new EngineRequestError("403", 403, "no")],
		])("%s keeps the masking message", async (_, cause) => {
			const res = await failWith(cause);
			const text = firstText(res);
			expect(text.startsWith("Nothing is returned: masking this result's secrets")).toBe(
				true
			);
			expect(text).not.toContain("Unexpected error");
			expect(res.structuredContent).toMatchObject({ error: { class: "transient" } });
		});
	});

	test.each([
		["list_runs", {}],
		["get_run", { runId: "run_1" }],
		["get_run_samples", { runId: "run_1" }],
		["get_inbox_captures", { inboxId: "inbox_1" }],
		["get_mock_activity", { mockId: "mock_1" }],
		["run_request", { url: "https://api.example.com/v1" }],
	])("%s fails closed on a failed secret lookup too", async (tool, args) => {
		const client = runClient({
			listAllRequests: vi.fn().mockRejectedValue(new Error("engine hiccup")),
			executeRequest: vi.fn().mockResolvedValue(EXECUTE_ANSWER),
		});
		const res = await dispatchTool(tool, args, ctxWith(client, ALLOW_API));
		expect(res.isError).toBe(true);
		expect(firstText(res)).toMatch(/the requests lookup .*failed \(engine hiccup\)/);
	});

	test("get_run_report masks a stored auth's literal key the engine wrote into the URL", async () => {
		const STORED_KEY = "stored-query-key-77";
		const report = {
			results: [
				{
					id: 1,
					trace: {
						request: {
							url: `https://api.example.com/v1?api_key=${STORED_KEY}`,
							rawRequest: `GET /v1?api_key=${STORED_KEY} HTTP/1.1\r\nHost: api.example.com\r\n\r\n`,
						},
					},
				},
			],
		};
		const client = runClient({
			listAllRequests: vi.fn().mockResolvedValue([
				{
					id: "r9",
					auth: { mode: "apikey", key: "api_key", value: STORED_KEY, in: "query" },
				},
			]),
			getRunReport: vi.fn().mockResolvedValue(report),
		});
		const withheld = await read("get_run_report", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain(STORED_KEY);
		expect(withheld.body.results[0].trace.request).toEqual({
			url: "https://api.example.com/v1?api_key=<redacted>",
			rawRequest: "GET /v1?api_key=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
		});
		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(report);
	});

	test("get_run_report masks the query value and headers the trace says auth wrote (#1835)", async () => {
		const TOKEN = "oauth-token-from-the-store-88";
		const SESSION = "session-header-value-99";
		const request = {
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			url: `https://api.example.com/v1?page=2&access_token=${TOKEN}`,
			headers: { "X-Session": SESSION },
			sentHeaders: { "X-Session": SESSION },
			rawRequest:
				`GET /v1?page=2&access_token=${TOKEN} HTTP/1.1\r\nHost: api.example.com\r\n` +
				`X-Session: ${SESSION}\r\n\r\n`,
		};
		const report = { results: [{ id: 1, trace: { request } }] };
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(report) });
		const withheld = await read("get_run_report", client, undefined, { runId: "run_1" });
		expect(withheld.text).not.toContain(TOKEN);
		expect(withheld.text).not.toContain(SESSION);
		expect(withheld.body.results[0].trace.request).toEqual({
			authQueryParam: "access_token",
			authHeaders: ["X-Session"],
			url: "https://api.example.com/v1?page=2&access_token=<redacted>",
			headers: { "X-Session": "<redacted>" },
			sentHeaders: { "X-Session": "<redacted>" },
			rawRequest:
				"GET /v1?page=2&access_token=<redacted> HTTP/1.1\r\nHost: api.example.com\r\n" +
				"X-Session: <redacted>\r\n\r\n",
		});
		const revealed = await read("get_run_report", client, REVEAL, { runId: "run_1" });
		expect(revealed.body).toEqual(report);
	});

	/** Three saved requests: one that runs and fails a test, one off the allowlist, one that errors. */
	const smokeClient = () =>
		runClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r_ok", name: "Runs" },
				{ id: "r_off", name: "Off the list" },
				{ id: "r_err", name: "Errors" },
			]),
			composeRequest: vi.fn().mockImplementation((body: { requestId?: string }) =>
				Promise.resolve(
					body.requestId === "r_off"
						? { method: "GET", url: "https://elsewhere.test/?k=glob-secret-1" }
						: {
								method: "GET",
								url: `https://api.example.com/v1?key=${QUERY_FORM}&id=${body.requestId}`,
							}
				)
			),
			executeRequest: vi.fn().mockImplementation((payload: { url: string }) =>
				payload.url.endsWith("r_err")
					? Promise.reject(new Error(`connect failed for ${payload.url}`))
					: Promise.resolve({
							status: 200,
							testResults: [
								{ name: "token echoed", passed: false, error: "got col-secret-9" },
							],
						})
			),
		});

	test("run_collection_smoke masks each row's URL, test lines and error unless revealed", async () => {
		const client = smokeClient();
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		expectRunOutputWithheld(withheld.text);
		expect(withheld.body.results).toEqual([
			{
				name: "Runs",
				method: "GET",
				url: "https://api.example.com/v1?key=<redacted>&id=r_ok",
				ok: false,
				statusCode: 200,
				tests: { total: 1, failed: 1, failures: ["token echoed: got <redacted>"] },
			},
			{
				name: "Off the list",
				method: "GET",
				url: "https://elsewhere.test/?k=<redacted>",
				ok: false,
				skipped: true,
				reason: expect.stringContaining("elsewhere.test"),
			},
			{
				name: "Errors",
				method: "GET",
				url: "https://api.example.com/v1?key=<redacted>&id=r_err",
				ok: false,
				error: "connect failed for https://api.example.com/v1?key=<redacted>&id=r_err",
			},
		]);

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.text).toContain(QUERY_FORM);
		expect(revealed.body.results[1].url).toBe("https://elsewhere.test/?k=glob-secret-1");
		expect(revealed.body.results[2].error).toContain(QUERY_FORM);
	});

	test("run_collection_smoke reads no secret to return its matrix with reveal on", async () => {
		const client = smokeClient();
		await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			{ collectionId: "c1" }
		);
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("run_collection_smoke withholds a stored URL's credentials on a request that fails to compose", async () => {
		const stored = "https://u:p4ssw0rd@api.example.com/x?api_key=S3CRET&page=2&tenant=T3NANT";
		const client = runClient({
			listRequests: vi.fn().mockResolvedValue([
				{
					id: "r_bad",
					name: "Unresolvable",
					method: "GET",
					url: stored,
					auth: { mode: "apikey", key: "tenant", value: "x", in: "query" },
				},
			]),
			composeRequest: vi
				.fn()
				.mockRejectedValue(new Error("variable {{missing}} is undefined")),
		});
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		for (const leak of ["p4ssw0rd", "S3CRET", "T3NANT"])
			expect(withheld.text).not.toContain(leak);
		expect(withheld.body.results[0]).toMatchObject({
			ok: false,
			url: "https://u@api.example.com/x?api_key=&page=2&tenant=",
		});

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.body.results[0].url).toBe(stored);
	});

	test("run_collection_smoke withholds a literal URL credential on every composed row kind", async () => {
		const typed = "https://u:S3cret@api.example.com/x?api_key=LIT&tenant=T3NANT";
		const client = runClient({
			listRequests: vi.fn().mockResolvedValue([
				{ id: "r_ok", name: "Runs" },
				{ id: "r_off", name: "Off the list" },
				{ id: "r_err", name: "Errors" },
			]),
			composeRequest: vi.fn().mockImplementation((body: { requestId?: string }) =>
				Promise.resolve({
					method: "GET",
					url: {
						r_ok: typed,
						r_off: "https://elsewhere.test/x?api_key=LIT",
						r_err: `${typed}&id=err`,
					}[body.requestId ?? ""],
					// An inherited API-key auth the stored row does not carry.
					auth: { mode: "apikey", key: "tenant", value: "x", in: "query" },
				})
			),
			executeRequest: vi
				.fn()
				.mockImplementation((payload: { url: string }) =>
					payload.url.endsWith("id=err")
						? Promise.reject(new Error("connect failed"))
						: Promise.resolve({ status: 200 })
				),
		});
		const args = { collectionId: "c1" };
		const withheld = await read("run_collection_smoke", client, ALLOW_API, args);
		for (const leak of ["S3cret", "LIT", "T3NANT"]) expect(withheld.text).not.toContain(leak);
		expect(withheld.body.results.map((row: { url: string }) => row.url)).toEqual([
			"https://u@api.example.com/x?api_key=&tenant=",
			"https://elsewhere.test/x?api_key=",
			"https://u@api.example.com/x?api_key=&tenant=&id=err",
		]);
		expect(
			withheld.body.results.map((row: Record<string, unknown>) => row.skipped ?? false)
		).toEqual([false, true, false]);
		expect(withheld.body.results[2].error).toBe("connect failed");
		// The send and the allowlist read the real URL, not the projection.
		expect(client.executeRequest).toHaveBeenCalledTimes(2);
		expect(client.executeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ url: typed }),
			undefined
		);

		const revealed = await read(
			"run_collection_smoke",
			client,
			{ ...ALLOW_API, ...REVEAL },
			args
		);
		expect(revealed.body.results.map((row: { url: string }) => row.url)).toEqual([
			typed,
			"https://elsewhere.test/x?api_key=LIT",
			`${typed}&id=err`,
		]);
	});

	/** A composed load target carrying a secret in its query, a header and its auth block. */
	const LOAD_TARGET = {
		method: "GET",
		url: `https://api.example.com/v1?key=${QUERY_FORM}`,
		headers: { Authorization: "Bearer typed-bearer-token", "X-Echo": "glob-secret-1" },
		auth: { mode: "bearer", token: "typed-bearer-token" },
	};

	const planLoadRun = (client: EngineClient, safety: Partial<McpSafetyConfig> = {}) => {
		const ctx = ctxWith(client, { ...ALLOW_API, ...safety });
		return dispatchTool("start_load_run", { requestId: "req_1", duration: "10s" }, ctx);
	};

	test("start_load_run's preview shows the planned run masked, its auth withheld", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const preview = firstText(await planLoadRun(client));
		expect(preview).toMatch(/AWAITING CONFIRMATION/);
		expectRunOutputWithheld(preview);
		const planned = JSON.parse(
			preview.slice(preview.indexOf("{"), preview.lastIndexOf("}") + 1)
		);
		expect(planned).toMatchObject({
			url: "https://api.example.com/v1?key=<redacted>",
			headers: { Authorization: "<redacted>", "X-Echo": "<redacted>" },
			auth: { mode: "bearer", tokenWithheld: true },
		});
		expect(planned.auth).not.toHaveProperty("token");
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("start_load_run's confirmation question names the masked target", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const asked = await dispatchTool(
			"start_load_run",
			{ requestId: "req_1", duration: "10s" },
			ctxAsking(client, ALLOW_API)
		);
		const message = askedQuestion(asked);
		expect(message).toContain("https://api.example.com/v1?key=<redacted>");
		expect(message).not.toContain("p@ss");
	});

	test("start_load_run's preview is the planned run as composed with reveal on, with no secret read", async () => {
		const client = runClient({ composeRequest: vi.fn().mockResolvedValue(LOAD_TARGET) });
		const preview = firstText(await planLoadRun(client, REVEAL));
		expect(preview).toContain(QUERY_FORM);
		expect(preview).toContain('"token": "typed-bearer-token"');
		expect(client.getGlobals).not.toHaveBeenCalled();
		expect(client.listAllRequests).not.toHaveBeenCalled();
	});

	test("compare_runs forwards no recorded string, so there is nothing for it to mask", async () => {
		const client = runClient({ getRunReport: vi.fn().mockResolvedValue(RUN_REPORT) });
		const res = await dispatchTool(
			"compare_runs",
			{ baseRunId: "run_0", targetRunId: "run_1" },
			ctxWith(client, REVEAL)
		);
		expect(res.isError).toBeFalsy();
		for (const leak of RUN_LEAKS) expect(JSON.stringify(res), leak).not.toContain(leak);
	});

	describe("export_run_report", () => {
		const exportOf = (text: string) =>
			runClient({
				exportRunReport: vi.fn().mockResolvedValue({ text, fileName: "r.run.json" }),
			});
		const exported = (client: EngineClient, safety?: Partial<McpSafetyConfig>) =>
			dispatchTool("export_run_report", { runId: "run_1" }, ctxWith(client, safety));

		test("masks a secret typed into a run comment unless revealed", async () => {
			const raw = `Rolled out with ${RUN_SECRET} as the password`;
			const asJson = JSON.stringify({ comment: raw });
			for (const text of [raw, asJson]) {
				const withheld = firstText(await exported(exportOf(text)));
				expect(withheld).not.toContain("w/rd");
				expect(withheld).toContain("<redacted> as the password");

				const revealed = firstText(await exported(exportOf(text), REVEAL));
				expect(revealed).toBe(text);
			}
		});

		test("reads no secret scope when reveal is on", async () => {
			const client = exportOf("plain");
			await exported(client, REVEAL);
			expect(client.getGlobals).not.toHaveBeenCalled();
		});

		test("fails whole when a masking read fails, rather than export unmasked", async () => {
			const client = runClient({
				exportRunReport: vi.fn().mockResolvedValue({ text: RUN_SECRET }),
				listEnvironments: vi.fn().mockRejectedValue(new Error("engine unreachable")),
			});
			const res = await exported(client);
			expect(res.isError).toBe(true);
			expect(firstText(res)).not.toContain("w/rd");
		});
	});

	const SPEC_DIFF = {
		identical: false,
		added: [],
		removed: [],
		unchanged: 0,
		unmapped: 0,
		changed: [
			{
				requestId: "req_1",
				name: "Me",
				fields: [
					{
						field: "headers",
						current: "2: Authorization=Bearer typed-bearer-token, Accept=json",
						next: "1: Accept=json",
						userTouched: false,
					},
					{ field: "url", current: "{{baseUrl}}/me", next: "{{baseUrl}}/v2/me" },
				],
			},
			{
				requestId: "req_2",
				name: "Referenced",
				fields: [
					{
						field: "headers",
						current: "1: Authorization={{token}}",
						next: "0: none",
						userTouched: true,
					},
				],
			},
		],
	};

	test("diff_spec withholds a stored header line that names a credential unless revealed", async () => {
		const client = fakeClient({ diffSpec: vi.fn().mockResolvedValue(SPEC_DIFF) });
		const args = { collectionId: "c1", content: "{}" };
		const withheld = await read("diff_spec", client, undefined, args);
		expect(withheld.text).not.toContain("typed-bearer-token");
		expect(withheld.body.changed[0].fields).toEqual([
			{ field: "headers", next: "1: Accept=json", userTouched: false, currentWithheld: true },
			{
				field: "url",
				current: "{{baseUrl}}/me",
				next: "{{baseUrl}}/v2/me",
				userTouched: false,
			},
		]);
		// A pure reference names where the secret lives without being it.
		expect(withheld.body.changed[1].fields[0].current).toBe("1: Authorization={{token}}");
		const revealed = await read("diff_spec", client, REVEAL, args);
		expect(revealed.body.changed[0].fields[0].current).toBe(
			"2: Authorization=Bearer typed-bearer-token, Accept=json"
		);
	});

	test("diff_spec withholds a stored URL and params line that could hold a credential unless revealed", async () => {
		const diff = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_1",
					name: "Credentialed",
					fields: [
						{
							field: "url",
							current: "https://u:p4ssw0rd@h/x?api_key=S3CRET",
							next: "{{baseUrl}}/x",
						},
						{ field: "params", current: "2: page=2, token=T0KEN", next: "1: page=2" },
					],
				},
				{
					requestId: "req_2",
					name: "Cut in the userinfo",
					fields: [
						{
							field: "url",
							current: "https://admin:hunt\u2026",
							next: "{{baseUrl}}/y",
						},
					],
				},
				{
					requestId: "req_3",
					name: "Benign",
					fields: [
						{
							field: "url",
							current: "{{baseUrl}}/z?page=2",
							next: "{{baseUrl}}/z?page=3",
						},
						{ field: "params", current: "1: page=2", next: "1: page=3" },
					],
				},
			],
		};
		const client = fakeClient({ diffSpec: vi.fn().mockResolvedValue(diff) });
		const args = { collectionId: "c1", content: "{}" };
		const withheld = await read("diff_spec", client, undefined, args);
		for (const leak of ["p4ssw0rd", "S3CRET", "T0KEN", "hunt"]) {
			expect(withheld.text).not.toContain(leak);
		}
		const [credentialed, cut, benign] = withheld.body.changed;
		expect(credentialed.fields).toEqual([
			{ field: "url", next: "{{baseUrl}}/x", userTouched: false, currentWithheld: true },
			{ field: "params", next: "1: page=2", userTouched: false, currentWithheld: true },
		]);
		expect(cut.fields).toEqual([
			{ field: "url", next: "{{baseUrl}}/y", userTouched: false, currentWithheld: true },
		]);
		expect(benign.fields).toEqual([
			{
				field: "url",
				current: "{{baseUrl}}/z?page=2",
				next: "{{baseUrl}}/z?page=3",
				userTouched: false,
			},
			{ field: "params", current: "1: page=2", next: "1: page=3", userTouched: false },
		]);

		const revealed = await read("diff_spec", client, REVEAL, args);
		expect(revealed.body.changed[0].fields[0].current).toBe(
			"https://u:p4ssw0rd@h/x?api_key=S3CRET"
		);
		expect(revealed.body.changed[0].fields[1].current).toBe("2: page=2, token=T0KEN");
		expect(revealed.body.changed[1].fields[0].current).toBe("https://admin:hunt\u2026");
	});

	describe("diff_spec reads the stored auth for a custom API-key query name", () => {
		const TENANT_DIFF = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_url",
					name: "Key in the url",
					fields: [
						{
							field: "url",
							current: "https://h/x?tenant=ACME-URL-SECRET&page=2",
							next: "{{baseUrl}}/x",
						},
					],
				},
				{
					requestId: "req_params",
					name: "Key in the params",
					fields: [
						{
							field: "params",
							current: "2: page=2, tenant=ACME-ROW-SECRET",
							next: "1: page=2",
						},
						{ field: "headers", current: "1: Accept=json", next: "0: none" },
					],
				},
				{
					requestId: "req_plain",
					name: "No key",
					fields: [
						{ field: "params", current: "1: tenant=acme", next: "1: tenant=beta" },
					],
				},
			],
		};
		const AUTH_BY_ID: Record<string, unknown> = {
			req_url: { mode: "apikey", in: "query", key: "tenant", value: "ACME-URL-SECRET" },
			req_params: { mode: "apikey", in: "query", key: "Tenant", value: "ACME-ROW-SECRET" },
			req_plain: { mode: "none" },
		};
		const clientWith = (getRequest: unknown) =>
			fakeClient({ diffSpec: vi.fn().mockResolvedValue(TENANT_DIFF), getRequest });
		const args = { collectionId: "c1", content: "{}" };

		test("withholds the key's value from a url and a params line unless revealed", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const client = clientWith(getRequest);
			const withheld = await read("diff_spec", client, undefined, args);
			for (const leak of ["ACME-URL-SECRET", "ACME-ROW-SECRET"]) {
				expect(withheld.text).not.toContain(leak);
			}
			const [url, params, plain] = withheld.body.changed;
			expect(url.fields[0]).toMatchObject({ field: "url", currentWithheld: true });
			expect(url.fields[0]).not.toHaveProperty("current");
			expect(params.fields[0]).toMatchObject({ field: "params", currentWithheld: true });
			expect(params.fields[1].current).toBe("1: Accept=json");
			// `tenant` is only a credential under a request that names it as its key.
			expect(plain.fields[0].current).toBe("1: tenant=acme");
			expect(getRequest.mock.calls.map(([id]) => id).sort()).toEqual([
				"req_params",
				"req_plain",
				"req_url",
			]);
		});

		test("reads nothing and returns the lines as written with reveal on", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const revealed = await read("diff_spec", clientWith(getRequest), REVEAL, args);
			expect(getRequest).not.toHaveBeenCalled();
			expect(revealed.body.changed[0].fields[0].current).toBe(
				"https://h/x?tenant=ACME-URL-SECRET&page=2"
			);
			expect(revealed.body.changed[1].fields[0].current).toBe(
				"2: page=2, tenant=ACME-ROW-SECRET"
			);
		});

		test("withholds a url and params line it could not read the auth for", async () => {
			const getRequest = vi.fn(async (id: string) => {
				if (id === "req_plain") return { id, auth: AUTH_BY_ID[id] };
				throw new Error("engine unreachable");
			});
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			for (const leak of ["ACME-URL-SECRET", "ACME-ROW-SECRET"]) {
				expect(withheld.text).not.toContain(leak);
			}
			const [url, params, plain] = withheld.body.changed;
			expect(url.fields[0].currentWithheld).toBe(true);
			expect(params.fields[0].currentWithheld).toBe(true);
			expect(params.fields[1].currentWithheld).toBe(true);
			expect(plain.fields[0].current).toBe("1: tenant=acme");
		});

		test("withholds when the lookup answers with something that is not a request", async () => {
			const withheld = await read(
				"diff_spec",
				clientWith(vi.fn().mockResolvedValue(null)),
				undefined,
				args
			);
			expect(withheld.text).not.toContain("ACME-URL-SECRET");
			expect(withheld.body.changed[0].fields[0].currentWithheld).toBe(true);
		});
	});

	describe("diff_spec reads the stored auth for a custom API-key header name", () => {
		const HEADER_DIFF = {
			...SPEC_DIFF,
			changed: [
				{
					requestId: "req_key",
					name: "Key in a header",
					fields: [
						{
							field: "headers",
							current: "2: Accept=json, X-Tenant=ACME-HEADER-SECRET",
							next: "1: Accept=json",
						},
					],
				},
				{
					requestId: "req_plain",
					name: "No key",
					fields: [
						{
							field: "headers",
							current: "2: Accept=json, X-Tenant=acme",
							next: "1: Accept=json",
						},
					],
				},
			],
		};
		const AUTH_BY_ID: Record<string, unknown> = {
			req_key: { mode: "apikey", in: "header", key: "X-Tenant", value: "ACME-HEADER-SECRET" },
			req_plain: { mode: "none" },
		};
		const clientWith = (getRequest: unknown) =>
			fakeClient({ diffSpec: vi.fn().mockResolvedValue(HEADER_DIFF), getRequest });
		const args = { collectionId: "c1", content: "{}" };

		test("withholds the key's row from a headers line unless revealed", async () => {
			const getRequest = vi.fn(async (id: string) => ({ id, auth: AUTH_BY_ID[id] }));
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			expect(withheld.text).not.toContain("ACME-HEADER-SECRET");
			const [key, plain] = withheld.body.changed;
			expect(key.fields[0]).toMatchObject({ field: "headers", currentWithheld: true });
			expect(key.fields[0]).not.toHaveProperty("current");
			// `X-Tenant` is only a credential under a request that names it as its key.
			expect(plain.fields[0].current).toBe("2: Accept=json, X-Tenant=acme");

			getRequest.mockClear();
			const revealed = await read("diff_spec", clientWith(getRequest), REVEAL, args);
			expect(getRequest).not.toHaveBeenCalled();
			expect(revealed.body.changed[0].fields[0].current).toBe(
				"2: Accept=json, X-Tenant=ACME-HEADER-SECRET"
			);
		});

		test("withholds a headers line it could not read the auth for", async () => {
			const getRequest = vi.fn(async (id: string) => {
				if (id === "req_plain") return { id, auth: AUTH_BY_ID[id] };
				throw new Error("engine unreachable");
			});
			const withheld = await read("diff_spec", clientWith(getRequest), undefined, args);
			expect(withheld.text).not.toContain("ACME-HEADER-SECRET");
			const [key, plain] = withheld.body.changed;
			expect(key.fields[0].currentWithheld).toBe(true);
			expect(plain.fields[0].current).toBe("2: Accept=json, X-Tenant=acme");
		});
	});

	test.each([
		"run_request",
		"get_run",
		"get_run_report",
		"export_run_report",
		"get_run_samples",
		"list_runs",
		"set_run_baseline",
		"get_inbox_captures",
	])("%s points at what it withholds from run output, only while reveal is off", (name) => {
		// The rules themselves are the server instructions' (server-host.test.ts).
		const tool = TOOLS.find((t) => t.name === name);
		const pointer = withheldPointer({ revealSecretsToAgents: false }, "recorded");
		expect(pointer).toContain(REDACTED_MARKER);
		expect(descriptionOf(tool)).toContain(pointer);
		expect(descriptionOf(tool, { revealSecretsToAgents: true })).not.toContain(REDACTED_MARKER);
	});

	test("get_mock_activity points at what it withholds, only while reveal is off", () => {
		const tool = TOOLS.find((t) => t.name === "get_mock_activity");
		expect(descriptionOf(tool)).toContain(
			withheldPointer({ revealSecretsToAgents: false }, "recorded")
		);
		expect(descriptionOf(tool, { revealSecretsToAgents: true })).not.toContain(REDACTED_MARKER);
	});
});

/**
 * A `binary` body names a file on the user's machine. An agent may store one,
 * but never choose it: the engine sends it only once a person picks it in the
 * editor or it sits under an allowed folder, and decides that from its own
 * records, so the stored reference carries no trust member at all (#2356). An
 * agent may never *send* a file inline - the refusal points it at running the
 * saved request by id. `dispatchTool` hands handlers the raw arguments (no zod
 * stripping), so an agent's own `unresolved: false` really does reach
 * `shapeBody` here.
 */
describe("binary file bodies", () => {
	const WRITE = { allowWrites: true };

	test("create_request stores a binary body without the agent's trust claim", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{
				collectionId: "c1",
				name: "Upload",
				url: "https://api.example.com/upload",
				method: "PUT",
				bodyType: "binary",
				file: { src: "/data/a.png", contentType: "image/png", unresolved: false },
			},
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBeFalsy();
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/data/a.png", contentType: "image/png" },
		});
		expect(payload.body.file).not.toHaveProperty("unresolved");
		expect(payload.bodyType).toBe("binary");
	});

	test("a lone `file` implies the binary mode", async () => {
		const client = fakeClient();
		await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "U", url: "https://x.test", file: { src: "/d/a.bin" } },
			ctxWith(client, WRITE)
		);
		const payload = (client.createRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/d/a.bin" },
		});
		expect(payload.bodyType).toBe("binary");
	});

	test("update_request replaces the body with a file reference", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"update_request",
			{
				requestId: "req_1",
				bodyType: "binary",
				file: { src: "/d/a.bin", fileName: "a.bin" },
			},
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBeFalsy();
		const [, payload] = (client.updateRequest as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(payload.body).toEqual({
			mode: "binary",
			file: { src: "/d/a.bin", fileName: "a.bin" },
		});
		expect(payload.bodyType).toBe("binary");
	});

	test.each([
		["binary with a body string", { bodyType: "binary", body: "x", file: { src: "/d/a" } }],
		["binary with no file", { bodyType: "binary" }],
		["binary with an empty path", { bodyType: "binary", file: { src: " " } }],
		["a file on another mode", { bodyType: "json", body: "{}", file: { src: "/d/a" } }],
	])("create_request refuses %s and writes nothing", async (_label, body) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "c1", name: "U", url: "https://x.test", ...body },
			ctxWith(client, WRITE)
		);
		expect(res.isError).toBe(true);
		expect(client.createRequest).not.toHaveBeenCalled();
	});

	test.each([
		["bodyType binary", { bodyType: "binary", file: { src: "/etc/passwd" } }],
		["a bare file", { file: { src: "/etc/passwd" } }],
	])("run_request refuses an inline file body (%s) before composing", async (_label, body) => {
		const client = fakeClient();
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/upload", method: "PUT", ...body },
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "app"));
		expect(firstText(res)).toContain("saved request by id");
		expect(client.composeRequest).not.toHaveBeenCalled();
		expect(client.executeRequest).not.toHaveBeenCalled();
	});

	test("start_load_run refuses an inline file body, even over a saved request", async () => {
		const client = fakeClient();
		const res = await dispatchTool(
			"start_load_run",
			{
				requestId: "req_1",
				bodyType: "binary",
				file: { src: "/etc/passwd" },
				mode: "iterations",
				iterations: 1,
				concurrency: 1,
				confirmed: true,
			},
			ctxWith(client, { allowlist: ["api.example.com"] })
		);
		expect(res.isError).toBe(true);
		expect(firstText(res)).toBe(resolveRemedyTokens(INLINE_FILE_REFUSAL, "app"));
		expect(client.startRun).not.toHaveBeenCalled();
	});

	test("every body-taking tool declares `file`, and none calls file parts unsupported wholesale", () => {
		const schemaOf = (name: string) =>
			TOOLS.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>;
		expect(schemaOf("create_request").file).toBeDefined();
		expect(schemaOf("update_request").file).toBeDefined();
		// The ad-hoc senders declare it too, only so it survives the SDK's zod
		// parse and reaches the refusal: stripped, it would send no body at all.
		for (const name of ["run_request", "start_load_run"]) {
			const parsed = z
				.object(schemaOf(name) as z.ZodRawShape)
				.parse({ url: "https://x.test", file: { src: "/d/a" } });
			expect(parsed.file, name).toEqual({ src: "/d/a" });
		}
		const descriptions = TOOLS.flatMap((tool) => {
			const schema = tool.inputSchema as Record<string, { description?: string }>;
			return schema?.bodyType?.description ? [schema.bodyType.description] : [];
		});
		expect(descriptions).toHaveLength(4);
		for (const description of descriptions) {
			expect(description).toContain("binary");
			expect(description).not.toContain("File parts are not supported");
		}
	});
});

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

/**
 * #2445: a read that declares an `outputSchema` answers `structuredContent`
 * the schema accepts, mirroring its text block. The SDK turns a result its
 * schema rejects into a protocol error that hides the whole answer, so each
 * row is dispatched with a realistic answer and parsed through the tool's own
 * schema; the paged reads, `compare_runs` and `get_engine_health` are held by
 * their own cases above.
 */
describe("every structured read answers structuredContent its outputSchema accepts", () => {
	const ENDPOINT = "https://api.example.com/graphql";

	interface StructuredRead {
		tool: string;
		args: Record<string, unknown>;
		client?: Partial<Record<keyof EngineClient, unknown>>;
		safety?: Partial<McpSafetyConfig>;
		/** The window's report, for the one tool that reads it rather than the engine. */
		appFocus?: ToolContext["appFocus"];
		/** Top-level keys the answer carries, so the schema's names are not vacuous. */
		has: string[];
		/** The engine method whose non-object answer the handler wraps as `{ raw }`. */
		wraps?: keyof EngineClient;
	}

	const SDL_ANSWER = {
		status: 200,
		bodyRaw: JSON.stringify({
			data: introspectionFromSchema(buildSchema("type Query { id: ID }")),
		}),
	};
	const OPERATION = { method: "GET", path: "/pets" };

	const READS: StructuredRead[] = [
		{
			tool: "get_app_focus",
			has: ["activeTab", "run", "activeEnvironment"],
			args: {},
			appFocus: () => ({
				activeTab: { type: "run", entityId: "run_9", label: "Design run" },
				activeEnvironment: { id: "env_1", name: "Staging" },
			}),
		},
		{
			tool: "get_safety_config",
			has: ["allowlist", "caps", "gates", "disabledToolCount"],
			args: {},
			safety: { allowlist: ["a.test"], allowAll: true },
		},
		{ tool: "resolve_variables", args: {}, has: ["context", "variables", "summary"] },
		{
			tool: "get_request",
			args: { requestId: "req_1" },
			has: ["id", "name", "method", "url"],
			wraps: "getRequest",
		},
		{
			tool: "get_run_report",
			has: ["metadata", "summary", "results", "partial", "note"],
			args: { runId: "run_1" },
			client: {
				getRunReport: vi.fn().mockResolvedValue({
					metadata: { runId: "run_1", runType: "load", status: "running", endTime: 0 },
					summary: { totalRequests: 3 },
					results: [],
				}),
			},
			wraps: "getRunReport",
		},
		{
			tool: "get_run",
			args: { runId: "run_b" },
			has: ["id", "status", "terminal", "progress", "nextStep"],
			wraps: "getRun",
		},
		{ tool: "get_engine_config", args: {}, has: ["entries"], wraps: "getConfig" },
		{
			tool: "get_graphql_schema",
			has: ["endpoint", "sdl", "sdlTruncated", "sdlBytes", "types"],
			args: { url: ENDPOINT },
			client: {
				listEnvironments: listingEnv1(),
				composeRequest: vi.fn().mockResolvedValue({ method: "POST", url: ENDPOINT }),
				executeRequest: vi.fn().mockResolvedValue(SDL_ANSWER),
			},
			safety: { allowlist: ["api.example.com"] },
		},
		{ tool: "get_spec", args: { collectionId: "col_1" }, has: ["collectionId", "bound"] },
		{
			tool: "get_spec",
			args: { specId: "spec_1", includeContent: true },
			has: ["specId", "hash", "contentBytes"],
		},
		{
			tool: "diff_spec",
			args: { collectionId: "col_1", content: "{}" },
			has: ["identical", "summary", "added", "removed", "changed", "entriesTruncated"],
		},
		{
			tool: "preview_import",
			has: ["collections", "environments", "globals", "clientCertificates", "meta"],
			args: { content: "{}" },
			client: {
				parseImport: vi.fn().mockResolvedValue({
					collections: [{ name: "Pets", requests: [{ name: "List" }], children: [] }],
					environments: [{ name: "Staging" }],
					meta: { format: "OpenAPI 3.0", skipped: [] },
				}),
			},
		},
		{
			tool: "preview_spec_bind",
			has: [
				"title",
				"operations",
				"matched",
				"wouldClear",
				"unmatchedRequests",
				"unmatchedOperations",
			],
			args: { collectionId: "col_1", content: "openapi: 3.0.0" },
			client: {
				describeSpec: vi.fn().mockResolvedValue({ title: "Pets", operations: [OPERATION] }),
				matchSpec: vi.fn().mockResolvedValue({
					matched: [],
					unmatchedRequests: [],
					unmatchedOperations: [OPERATION],
				}),
				listCollections: vi.fn().mockResolvedValue([{ id: "col_1", parentId: null }]),
			},
		},
		{
			tool: "export_spec",
			args: { collectionId: "col_1" },
			has: ["format", "mode", "document", "documentTruncated", "contentBytes"],
		},
		{
			tool: "export_postman",
			args: { collectionId: "col_1" },
			has: ["fileName", "document", "documentTruncated", "contentBytes"],
		},
		{
			tool: "list_request_examples",
			has: ["examples", "bodiesOmitted", "bodyBudgetBytes"],
			args: { requestId: "req_1" },
			client: {
				listRequestExamples: vi.fn().mockResolvedValue([{ id: "ex_1", body: "{}" }]),
			},
		},
		{
			tool: "get_globals",
			args: {},
			has: ["id", "variables", "updatedAt"],
			wraps: "getGlobals",
		},
		{
			tool: "get_oauth2_token_status",
			has: ["found"],
			args: { cacheKey: "k" },
			wraps: "getOAuth2TokenStatus",
		},
		{ tool: "list_mock_issuers", args: {}, has: ["issuers"], wraps: "listMockIssuers" },
		{ tool: "list_mock_servers", args: {}, has: ["data"], wraps: "listMockServers" },
		{
			tool: "get_mock_routes",
			has: ["data"],
			args: { mockId: "mock_1" },
			wraps: "getMockServerRoutes",
		},
		{
			tool: "get_mock_activity",
			has: ["data"],
			args: { mockId: "mock_1" },
			wraps: "getMockServerActivity",
		},
		{ tool: "list_webhook_inboxes", args: {}, has: ["data"], wraps: "listInboxes" },
	];

	/** Held by the paged-read and comparison cases above, not by a row here. */
	const COVERED_ELSEWHERE = [
		"get_engine_health",
		"compare_runs",
		"list_runs",
		"get_run_samples",
		"get_run_timeseries",
		"get_run_monitor",
		"get_inbox_captures",
		"list_collections",
		"list_requests",
		"get_cookies",
		"list_trash",
	];

	/** @p tool's declared outputSchema; its absence fails the case rather than skipping it. */
	function outputSchemaOf(tool: string) {
		const schema = TOOLS.find((t) => t.name === tool)?.outputSchema;
		expect(schema, tool).toBeDefined();
		return schema!;
	}

	function dispatchRead(read: StructuredRead, overrides: Partial<StructuredRead["client"]> = {}) {
		const client = fakeClient({ ...read.client, ...overrides });
		const ctx = { ...ctxWith(client, read.safety), appFocus: read.appFocus };
		return dispatchTool(read.tool, read.args, ctx);
	}

	test("every read tool with a schema is held here or by a case above", () => {
		const held = new Set([...READS.map((read) => read.tool), ...COVERED_ELSEWHERE]);
		const unheld = TOOLS.filter(
			(tool) => tool.category === "read" && tool.outputSchema && !held.has(tool.name)
		).map((tool) => tool.name);
		expect(unheld).toEqual([]);
	});

	// A prose caveat may follow the first block (`withCaveat`); that block is the document.
	test.each(READS)("$tool $args: the first block is the structured document", async (read) => {
		const res = await dispatchRead(read);
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toEqual(JSON.parse(firstText(res)));
		expect(Object.keys(res.structuredContent!)).toEqual(expect.arrayContaining(read.has));
		expect(() => outputSchemaOf(read.tool).parse(res.structuredContent)).not.toThrow();
	});

	const WRAPPING = READS.filter((read) => read.wraps);

	test.each(WRAPPING)("$tool: a non-object answer is wrapped, not refused", async (read) => {
		for (const answer of [null, ["bare"]]) {
			const res = await dispatchRead(read, {
				[read.wraps!]: vi.fn().mockResolvedValue(answer),
			});
			expect(res.isError).toBeFalsy();
			expect(res.structuredContent).toEqual({ raw: answer });
			expect(() => outputSchemaOf(read.tool).parse(res.structuredContent)).not.toThrow();
		}
	});

	test("a key the schema does not name still arrives", async () => {
		const res = await dispatchRead(
			READS.find((read) => read.tool === "get_run")!,
			{ getRun: vi.fn().mockResolvedValue({ id: "run_1", status: "completed", novel: 1 }) }
		);
		expect(res.structuredContent).toMatchObject({ id: "run_1", terminal: true });
		const parsed = outputSchemaOf("get_run").parse({ id: "run_1", novel: 1 });
		expect(parsed).toMatchObject({ novel: 1 });
	});
});
