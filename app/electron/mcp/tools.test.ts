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
	MAX_INBOX_CAPTURE_LIMIT,
	MAX_IN_FLIGHT_BOUND,
	MAX_INLINE_BODY_BYTES,
	MAX_REPORT_TRACE_BYTES,
	MAX_RUN_SERIES_LIMIT,
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
		getEnvironment: vi.fn().mockResolvedValue({
			id: "env_1",
			name: "Dev",
			variables: { baseUrl: { value: "x", enabled: true } },
		}),
		updateEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev" }),
		startMockIssuer: vi.fn().mockResolvedValue({
			issuerId: "issuer_1",
			issuerUrl: "http://127.0.0.1:41234",
			tokenUrl: "http://127.0.0.1:41234/token",
			authorizeUrl: "http://127.0.0.1:41234/authorize",
			signingKey: "k3y",
		}),
		listMockIssuers: vi.fn().mockResolvedValue({ issuers: [] }),
		stopMockIssuer: vi.fn().mockResolvedValue({ stopped: true }),
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
					{
						key: "workers",
						value: "16",
						label: "Worker Threads",
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
			{ entries: { workers: "16", timeoutMs: "5000" } },
			ctxWith(client, { allowWrites: true })
		);
		expect(res.isError).toBeFalsy();
		const out = res.structuredContent as { changedKeys: string[]; restartRequired: string[] };
		expect(out.changedKeys.sort()).toEqual(["timeoutMs", "workers"]);
		expect(out.restartRequired).toEqual(["workers"]);
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

	test("start and stop are execute, list is read, and none of them opens the world", () => {
		const tools = byName();
		expect(tools.get("start_mock_issuer")?.category).toBe("execute");
		expect(tools.get("stop_mock_issuer")?.category).toBe("execute");
		expect(tools.get("list_mock_issuers")?.category).toBe("read");
		for (const name of ["start_mock_issuer", "stop_mock_issuer", "list_mock_issuers"]) {
			// Loopback-only by engine contract, so an agent's client must not be
			// told these reach an open world - that hint is what a cautious client
			// asks about before calling.
			expect(tools.get(name)?.annotations.openWorldHint, name).toBe(false);
			expect(tools.get(name)?.annotations.destructiveHint, name).toBeFalsy();
		}
	});

	test("they invalidate nothing, because no renderer surface reads issuers yet", () => {
		// The #502 coordination, locked so it is a decision rather than an
		// oversight: declaring an entity here before the Services drawer reads it
		// is precisely the written-never-read defect. When #502 lands, this
		// expectation changes with it.
		for (const name of ["start_mock_issuer", "stop_mock_issuer", "list_mock_issuers"]) {
			expect(byName().get(name)?.invalidates, name).toEqual([]);
		}
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
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, locked);
			expect(res.isError, tool).toBeFalsy();
		}
		expect(client.startMockIssuer).toHaveBeenCalled();
		expect(client.stopMockIssuer).toHaveBeenCalled();
	});

	test("the per-tool switch is what turns them off", async () => {
		const client = fakeClient();
		const off = ctxWith(client, {
			disabledTools: ["start_mock_issuer", "list_mock_issuers", "stop_mock_issuer"],
		});
		for (const [tool, args] of [
			["start_mock_issuer", {}],
			["list_mock_issuers", {}],
			["stop_mock_issuer", { issuerId: "issuer_1" }],
		] as const) {
			const res = await dispatchTool(tool, args, off);
			expect(res.isError, tool).toBe(true);
			expect(firstText(res), tool).toMatch(/disabled in Vayu Settings/);
		}
		expect(client.startMockIssuer).not.toHaveBeenCalled();
		expect(client.listMockIssuers).not.toHaveBeenCalled();
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
