/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `mcp:data-changed` emit at the dispatch chokepoint.
 *
 * `tools.test.ts` owns what each tool sends to the engine; this owns the one
 * thing that happens *after* a call succeeds - the renderer being told what
 * went stale. Kept in its own file because every test here needs the notifier
 * in the context, which none of the tests over there want.
 */

import { describe, expect, test, vi } from "vitest";
import {
	dispatchTool,
	MCP_DATA_ENTITIES,
	TOOLS,
	type McpDataChangedEvent,
	type ToolContext,
} from "./tools.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";

/** Minimal engine client for the calls exercised below. */
function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}) {
	return {
		health: vi.fn().mockResolvedValue({ status: "ok", version: "1.2.3" }),
		listCollections: vi.fn().mockResolvedValue([]),
		listRuns: vi.fn().mockResolvedValue([]),
		listRequests: vi.fn().mockResolvedValue([]),
		createRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "New" }),
		getRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "Get users", method: "GET" }),
		updateRequest: vi.fn().mockResolvedValue({ id: "req_1", name: "Renamed" }),
		deleteRequest: vi.fn().mockResolvedValue({ message: "Request deleted successfully" }),
		createCollection: vi.fn().mockResolvedValue({ id: "col_1", name: "API" }),
		deleteCollection: vi.fn().mockResolvedValue({ message: "Collection deleted successfully" }),
		updateConfig: vi.fn().mockResolvedValue({ entries: [] }),
		getConfig: vi.fn().mockResolvedValue({ entries: [] }),
		getEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev", variables: {} }),
		updateEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev" }),
		executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
		stopRun: vi.fn().mockResolvedValue({ message: "Run stopped" }),
		composeRequest: vi
			.fn()
			.mockImplementation((body: { request?: object }) =>
				Promise.resolve({ ...(body.request ?? {}) })
			),
		...overrides,
	} as unknown as EngineClient;
}

/** A context plus the notifier spy, so a test can read what was emitted. */
function ctxWithNotifier(client: EngineClient, safety?: Partial<McpSafetyConfig>) {
	const onDataChanged = vi.fn<(event: McpDataChangedEvent) => void>();
	const ctx: ToolContext = { client, config: resolveSafetyConfig(safety), onDataChanged };
	return { ctx, onDataChanged };
}

const WRITES_ENABLED: Partial<McpSafetyConfig> = { allowWrites: true };

describe("the registry declares its effects", () => {
	test("every tool declares `invalidates`, using only known entities", () => {
		for (const tool of TOOLS) {
			expect(Array.isArray(tool.invalidates), `${tool.name} must declare invalidates`).toBe(
				true
			);
			for (const entity of tool.invalidates) {
				expect(MCP_DATA_ENTITIES, `${tool.name} declares an unknown entity`).toContain(
					entity
				);
			}
		}
	});

	test("read tools change nothing", () => {
		for (const tool of TOOLS.filter((t) => t.category === "read")) {
			expect(tool.invalidates, `${tool.name} is a read tool`).toEqual([]);
		}
	});

	test("every mutating tool declares at least one entity", () => {
		// The list is spelled out rather than derived from `category`, because
		// which family a tool touches is exactly what `category` does not say -
		// an `execute` tool writes a run row and refills the cookie jar.
		const expected: Record<string, string[]> = {
			create_collection: ["collection"],
			update_collection: ["collection"],
			delete_collection: ["collection"],
			create_request: ["request"],
			update_request: ["request"],
			delete_request: ["request"],
			update_environment: ["environment"],
			update_engine_config: ["config"],
			run_request: ["run", "cookie"],
			run_collection_smoke: ["run", "cookie"],
			// The design-mode runner is the one executor handed the cookie jar
			// (`start_scenario_run`), so its steps refill it the way a Send does.
			run_collection: ["run", "cookie"],
			start_load_run: ["run"],
			stop_run: ["run"],
		};
		for (const [name, entities] of Object.entries(expected)) {
			const tool = TOOLS.find((t) => t.name === name);
			expect(tool, `${name} is missing from the registry`).toBeDefined();
			expect(tool!.invalidates, name).toEqual(entities);
		}
		// Nothing else mutates: a new tool that does must be added above, or this
		// guard would pass while its writes stayed invisible to the renderer.
		const mutating = TOOLS.filter((t) => t.invalidates.length > 0).map((t) => t.name);
		expect(mutating.sort()).toEqual(Object.keys(expected).sort());
	});
});

describe("dispatch emits mcp:data-changed", () => {
	test("a successful write emits exactly one event for its entity", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "col_1", name: "New", url: "https://api.example.com/x" },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).toHaveBeenCalledTimes(1);
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "request", collectionId: "col_1" });
	});

	test("a collection write reports the collection family", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("create_collection", { name: "API" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "collection" });
	});

	test("a cascade delete reports the collection family once it has happened", async () => {
		const client = fakeClient({
			listCollections: vi
				.fn()
				.mockResolvedValue([{ id: "col_1", name: "API", parentId: "" }]),
		});
		const { ctx, onDataChanged } = ctxWithNotifier(client, WRITES_ENABLED);
		const res = await dispatchTool(
			"delete_collection",
			{ collectionId: "col_1", confirmed: true },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "collection", collectionId: "col_1" });
	});

	test("an unconfirmed delete emits nothing - nothing changed", async () => {
		// The preview is a successful result, so "not an error" is not the test:
		// the emit has to hang off the delete actually happening.
		const client = fakeClient({
			listCollections: vi
				.fn()
				.mockResolvedValue([{ id: "col_1", name: "API", parentId: "" }]),
		});
		const { ctx, onDataChanged } = ctxWithNotifier(client, WRITES_ENABLED);
		const res = await dispatchTool("delete_collection", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(client.deleteCollection).not.toHaveBeenCalled();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("an unstarted load run emits nothing either", async () => {
		// Same rule as the delete preview, on the gate that has always had one: a
		// described run is not a run, and the history lists have not moved.
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			allowlist: ["api.example.com"],
		});
		const res = await dispatchTool(
			"start_load_run",
			{ url: "https://api.example.com/x", mode: "constant_rps", targetRps: 10 },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("a single-request write carries the row id as its scope hint", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool(
			"update_request",
			{ requestId: "req_1", name: "Renamed" },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "request", requestId: "req_1" });
	});

	test("a failed dispatch emits nothing", async () => {
		// Writes are off by default, so the tool refuses before touching the engine.
		const client = fakeClient();
		const { ctx, onDataChanged } = ctxWithNotifier(client);
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "col_1", name: "New", url: "https://api.example.com/x" },
			ctx
		);
		expect(res.isError).toBe(true);
		expect(client.createRequest).not.toHaveBeenCalled();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("an engine error emits nothing", async () => {
		const client = fakeClient({
			createRequest: vi.fn().mockRejectedValue(new Error("fetch failed")),
		});
		const { ctx, onDataChanged } = ctxWithNotifier(client, WRITES_ENABLED);
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "col_1", name: "New", url: "https://api.example.com/x" },
			ctx
		);
		expect(res.isError).toBe(true);
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("a read tool emits nothing", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("list_collections", {}, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("a disabled tool emits nothing", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			...WRITES_ENABLED,
			disabledTools: ["create_request"],
		});
		const res = await dispatchTool("create_request", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBe(true);
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("a tool declaring two entities emits one event each", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			allowlist: ["api.example.com"],
		});
		const res = await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users", requestId: "req_7" },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged.mock.calls.map(([e]) => e.entity)).toEqual(["run", "cookie"]);
	});

	test("the call's own arguments become the scope hints", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			allowlist: ["api.example.com"],
		});
		await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users", requestId: "req_7" },
			ctx
		);
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "run", requestId: "req_7" });
	});

	test("hints the call did not name are absent, not empty strings", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			allowlist: ["api.example.com"],
		});
		await dispatchTool("run_request", { url: "https://api.example.com/users" }, ctx);
		const event = onDataChanged.mock.calls[0][0];
		expect(event).toEqual({ entity: "run" });
		expect("requestId" in event).toBe(false);
	});

	test("stop_run reports the run family", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("stop_run", { runId: "run_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "run" });
	});

	test("a context without a notifier dispatches normally", async () => {
		const client = fakeClient();
		const ctx: ToolContext = { client, config: resolveSafetyConfig(WRITES_ENABLED) };
		const res = await dispatchTool(
			"create_request",
			{ collectionId: "col_1", name: "New", url: "https://api.example.com/x" },
			ctx
		);
		expect(res.isError).toBeFalsy();
		expect(client.createRequest).toHaveBeenCalledTimes(1);
	});

	test("a throwing listener does not fail a write the engine already applied", async () => {
		const client = fakeClient();
		const ctx: ToolContext = {
			client,
			config: resolveSafetyConfig(WRITES_ENABLED),
			onDataChanged: () => {
				throw new Error("renderer went away");
			},
		};
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await dispatchTool(
				"create_request",
				{ collectionId: "col_1", name: "New", url: "https://api.example.com/x" },
				ctx
			);
			expect(res.isError).toBeFalsy();
			expect(client.createRequest).toHaveBeenCalledTimes(1);
			expect(errorLog).toHaveBeenCalled();
		} finally {
			errorLog.mockRestore();
		}
	});
});
