/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { buildSchema, introspectionFromSchema } from "graphql";
import { dispatchTool, TOOLS, type ToolContext } from "./tools.js";
import { jsonResult, structuredResult } from "./tools/kit.js";
import type { McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import {
	listingEnv1,
	fakeClient,
	ctxWith,
	firstText,
	ELEMENT_KINDS,
	SCRIPT_COMPLETIONS,
} from "./tools.testkit.js";

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
			tool: "list_element_kinds",
			args: {},
			has: ["kinds"],
			client: { getElementKinds: vi.fn().mockResolvedValue(ELEMENT_KINDS) },
		},
		{
			tool: "list_element_kinds",
			args: { kind: "assert.status" },
			has: ["kind", "configSchema"],
			client: { getElementKinds: vi.fn().mockResolvedValue(ELEMENT_KINDS) },
		},
		{
			tool: "get_script_api",
			args: { q: "pm" },
			has: ["completions"],
			client: { getScriptCompletions: vi.fn().mockResolvedValue(SCRIPT_COMPLETIONS) },
		},
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
			tool: "read_body",
			has: ["text", "offset", "nextOffset", "totalBytes", "encoding", "done"],
			args: { runId: "run_1", resultId: 1 },
			client: {
				getRunResult: vi
					.fn()
					.mockResolvedValue({ id: 1, trace: { response: { body: "{}" } } }),
			},
		},
		{
			tool: "diff_bodies",
			has: ["kind", "equal", "a", "b", "differenceCount", "differences", "omitted"],
			args: { a: { runId: "run_1", resultId: 1 }, b: { runId: "run_1", resultId: 2 } },
			client: {
				getRunResult: vi.fn((_run: string, id: number) =>
					Promise.resolve({ id, trace: { response: { body: `{"id":${id}}` } } })
				),
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
		{ tool: "get_live_metrics", args: { runId: "run_1" }, has: ["ticks", "completed"] },
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

/*
 * The reader of a result is a model's context window, so indentation is cost
 * with no reader (#3560). A newline in a JSON result's text means a pretty
 * printer is back.
 */
describe("result text is compact JSON", () => {
	const NESTED = { allowlist: ["a.test"], caps: { duration: { max: 60 }, rows: [{ a: 1 }] } };

	test("jsonResult and structuredResult carry no newline or indent", () => {
		for (const result of [jsonResult(NESTED), structuredResult(NESTED)]) {
			expect(firstText(result as { content: Array<{ text: string }> })).toBe(
				JSON.stringify(NESTED)
			);
		}
	});

	test("a structured read tool's text has no newline and equals its structuredContent", async () => {
		const res = await dispatchTool(
			"get_safety_config",
			{},
			ctxWith(fakeClient(), { allowlist: ["a.test"], allowAll: true })
		);
		expect(firstText(res)).not.toContain("\n");
		expect(JSON.parse(firstText(res))).toEqual(res.structuredContent);
	});
});
