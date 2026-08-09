/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	dispatchTool,
	MAX_IN_FLIGHT_BOUND,
	toolCatalog,
	TOOLS,
	type ToolContext,
} from "./tools.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { EngineRequestError, EngineTimeoutError, type EngineClient } from "./engine-client.js";
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

/** Build a fake EngineClient with vi.fn()s for the methods under test. */
function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
	return {
		health: vi.fn().mockResolvedValue({ status: "ok", version: "1.2.3" }),
		listCollections: vi.fn().mockResolvedValue([]),
		listRequests: vi.fn().mockResolvedValue([]),
		listEnvironments: vi.fn().mockResolvedValue([]),
		listRuns: vi.fn().mockResolvedValue([]),
		getRunReport: vi.fn().mockResolvedValue({ latency: {}, summary: {}, statusCodes: {} }),
		composeRequest: identityCompose(),
		executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "running" }),
		stopRun: vi.fn().mockResolvedValue({ message: "Run stopped" }),
		getLiveMetricsSnapshot: vi.fn().mockResolvedValue([{ currentRps: 100 }]),
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
					{ key: "workers", value: "16", label: "Worker threads (Requires Restart)" },
					{ key: "timeoutMs", value: "5000", label: "Request timeout" },
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
