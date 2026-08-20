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
		listEnvironments: vi.fn().mockResolvedValue([{ id: "env_1", name: "Dev", isActive: true }]),
		createEnvironment: vi.fn().mockResolvedValue({ id: "env_2", name: "Staging" }),
		updateEnvironment: vi.fn().mockResolvedValue({ id: "env_1", name: "Dev" }),
		deleteEnvironment: vi.fn().mockResolvedValue({ success: true }),
		getGlobals: vi.fn().mockResolvedValue({ id: "globals", variables: {} }),
		saveGlobals: vi.fn().mockResolvedValue({ id: "globals", variables: {} }),
		getCookies: vi.fn().mockResolvedValue({ scopes: [] }),
		clearCookies: vi.fn().mockResolvedValue({ cleared: 3 }),
		executeRequest: vi.fn().mockResolvedValue({ statusCode: 200 }),
		stopRun: vi.fn().mockResolvedValue({ message: "Run stopped" }),
		getRun: vi.fn().mockResolvedValue({ id: "run_1", type: "load", status: "completed" }),
		deleteRun: vi.fn().mockResolvedValue({ message: "Run deleted successfully" }),
		setRunBaseline: vi.fn().mockResolvedValue({ id: "run_1", baseline: true }),
		startInbox: vi
			.fn()
			.mockResolvedValue({ inboxId: "inbox_1", url: "http://127.0.0.1:45001" }),
		listInboxes: vi.fn().mockResolvedValue({
			data: [{ inboxId: "inbox_1", url: "http://127.0.0.1:45001", captureCount: 2 }],
		}),
		stopInbox: vi.fn().mockResolvedValue({ inboxId: "inbox_1", running: false }),
		deleteInbox: vi.fn().mockResolvedValue({ inboxId: "inbox_1", capturesDeleted: 2 }),
		clearInboxCaptures: vi.fn().mockResolvedValue({ inboxId: "inbox_1", cleared: 2 }),
		updateInboxResponse: vi.fn().mockResolvedValue({ inboxId: "inbox_1" }),
		startMockServer: vi.fn().mockResolvedValue({
			mockId: "mock_1",
			url: "http://127.0.0.1:45010",
			routeCount: 3,
			routesWithoutExample: 0,
		}),
		stopMockServer: vi.fn().mockResolvedValue({ mockId: "mock_1", stopped: true }),
		startMockIssuer: vi.fn().mockResolvedValue({ issuerId: "issuer_1" }),
		stopMockIssuer: vi.fn().mockResolvedValue({ stopped: true }),
		updateMockIssuer: vi.fn().mockResolvedValue({ issuerId: "issuer_1", failureMode: "slow" }),
		fetchOAuth2Token: vi
			.fn()
			.mockResolvedValue({ cacheKey: "key_1", accessToken: "bearer", expiresIn: 3600 }),
		getOAuth2TokenStatus: vi.fn().mockResolvedValue({ found: true, expired: false }),
		clearOAuth2Token: vi.fn().mockResolvedValue({ deleted: true }),
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
			// Detaching an OpenAPI document (#761 phase A) rewrites one field of
			// the collection row - `openapi` - and the Spec tab reads the binding
			// off that row, so the family that refetches collections is the one
			// that refreshes it. No `spec` family: the stored document is
			// immutable under its id and this write neither changes nor deletes
			// one, so the caches keyed by spec id cannot go stale here.
			unbind_spec: ["collection"],
			// Binding (#862) writes both families: the binding is a field of the
			// collection row, and the identity it stamps - and clears - lives on
			// the requests beneath it. Still no `spec` family, for the reason
			// unbinding has none: a stored document is immutable under its id, so
			// a bind mints a new row rather than staling a cached one.
			bind_spec: ["collection", "request"],
			// A sync (#871) moves the same two: the document and the binding are
			// collection state, and the rows it creates, updates and deletes are
			// requests. No `spec` family for the same reason a bind has none - it
			// mints a new document row rather than changing a stored one.
			sync_spec: ["collection", "request"],
			create_request: ["request"],
			update_request: ["request"],
			delete_request: ["request"],
			// Document CRUD (#759). The example tools take the `request` family
			// because that is where their rows live: the examples query key is
			// nested under `requests.detail(id)`, so invalidating the request the
			// call named reaches the open Examples panel too.
			create_request_example: ["request"],
			update_request_example: ["request"],
			delete_request_example: ["request"],
			// A move changes both trees at once - the row leaves one parent's
			// list and joins another's - and a moved collection takes its
			// requests with it, which is why it declares the pair rather than
			// the family of the thing moved.
			move_item: ["collection", "request"],
			update_environment: ["environment"],
			// State CRUD (#758). The globals writer takes the `environment` family
			// rather than one of its own: same resolution order, same blob shape,
			// and the renderer's invalidator takes the globals key with it.
			create_environment: ["environment"],
			activate_environment: ["environment"],
			delete_environment: ["environment"],
			update_globals: ["environment"],
			// The jar has always been its own family - `run_request` refills it -
			// and clearing one is the same family read from the other end.
			clear_cookies: ["cookie"],
			update_engine_config: ["config"],
			run_request: ["run", "cookie"],
			run_collection_smoke: ["run", "cookie"],
			// The design-mode runner is the one executor handed the cookie jar
			// (`start_scenario_run`), so its steps refill it the way a Send does.
			run_collection: ["run", "cookie"],
			start_load_run: ["run"],
			stop_run: ["run"],
			// Run housekeeping (#755): both rewrite a history row the renderer
			// lists, so both invalidate `run` exactly as the runners do.
			set_run_baseline: ["run"],
			delete_run: ["run"],
			// Webhook inboxes (#756): every one of these changes what the Services
			// drawer and the Dock's running-services count answer, and the two
			// that touch captures change what an open inbox tab is showing.
			start_webhook_inbox: ["service"],
			stop_webhook_inbox: ["service"],
			delete_webhook_inbox: ["service"],
			clear_inbox_captures: ["service"],
			update_inbox_response: ["service"],
			// Mock servers and issuers (#757): the same drawer and the same count,
			// so the same family. The issuer tools shipped with `invalidates: []`
			// and a note saying #757 would take it - this is that.
			start_mock_server: ["service"],
			stop_mock_server: ["service"],
			start_mock_issuer: ["service"],
			stop_mock_issuer: ["service"],
			update_mock_issuer: ["service"],
			// The OAuth 2.0 token cache (#760): both change what the auth tab's
			// token-status row reports, and it polls at 30s - long enough to keep
			// showing an entry an agent has already cleared.
			fetch_oauth2_token: ["oauth"],
			clear_oauth2_token: ["oauth"],
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

	test("deactivating when nothing was active emits nothing", async () => {
		// The third `unchanged` shape (#758): a successful call that found nothing
		// to write. Emitting here would refetch the environment list, the globals
		// and every composition to report a change no row records.
		const client = fakeClient({
			listEnvironments: vi.fn().mockResolvedValue([{ id: "env_1", isActive: false }]),
		});
		const { ctx, onDataChanged } = ctxWithNotifier(client, WRITES_ENABLED);
		const res = await dispatchTool("activate_environment", { environmentId: "none" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(client.updateEnvironment).not.toHaveBeenCalled();
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

	test("run housekeeping writes report the run family", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const pinned = await dispatchTool(
			"set_run_baseline",
			{ runId: "run_1", baseline: true },
			ctx
		);
		expect(pinned.isError).toBeFalsy();
		const deleted = await dispatchTool("delete_run", { runId: "run_1", confirmed: true }, ctx);
		expect(deleted.isError).toBeFalsy();
		expect(onDataChanged.mock.calls.map(([e]) => e.entity)).toEqual(["run", "run"]);
	});

	test("a housekeeping write carries the run id as its scope hint", async () => {
		// The renderer needs it to drop that one run's report and series caches
		// (issue #774): they are `staleTime: Infinity` and keyed per run, so
		// without the hint a deleted run keeps rendering under an open tab.
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		await dispatchTool("delete_run", { runId: "run_1", confirmed: true }, ctx);
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "run", runId: "run_1" });
	});

	test("a runner names no run id - the run it made has no per-run cache yet", async () => {
		// The hint means "this existing run changed"; attaching it to a create
		// would drop caches for a run nothing has fetched.
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), {
			allowlist: ["api.example.com"],
		});
		await dispatchTool(
			"run_request",
			{ url: "https://api.example.com/users", requestId: "req_7" },
			ctx
		);
		const event = onDataChanged.mock.calls[0][0];
		expect("runId" in event).toBe(false);
	});

	test("a delete_run preview changed nothing, so it notifies nothing", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("delete_run", { runId: "run_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("stop_run reports the run family", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("stop_run", { runId: "run_1" }, ctx);
		expect(res.isError).toBeFalsy();
		// With the hint, because a stopped run's own report and series are what
		// changed - it went terminal.
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "run", runId: "run_1" });
	});

	test("an inbox call names the inbox it acted on, so the captures cache can be dropped", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("clear_inbox_captures", { inboxId: "inbox_1" }, ctx);
		expect(res.isError).toBeFalsy();
		// The hint is what makes a clear correct renderer-side: an invalidation
		// alone refetches into a cache that still holds the cleared rows and
		// unions them straight back (see `lib/mcp-invalidation.ts`).
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "service", inboxId: "inbox_1" });
	});

	test("starting an inbox reports the family with no id to narrow by", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("start_webhook_inbox", { port: 0 }, ctx);
		expect(res.isError).toBeFalsy();
		// The engine assigns the id, so there is none in the arguments - and a new
		// inbox has no capture cache to drop anyway.
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "service" });
	});

	test("stopping a mock names it, so its route-table cache can be dropped", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("stop_mock_server", { mockId: "mock_1" }, ctx);
		expect(res.isError).toBeFalsy();
		// The hint is what makes a stop correct renderer-side: the route table is
		// held at `staleTime: Infinity`, so an invalidation would not refetch it,
		// and the id it belongs to no longer exists to refetch from.
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "service", mockId: "mock_1" });
	});

	test("starting a mock reports the family with no id to narrow by", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("start_mock_server", { collectionId: "col_1" }, ctx);
		expect(res.isError).toBeFalsy();
		// The engine assigns the mock id, so the arguments carry only the
		// collection - and a mock that just started has no cached table to drop.
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "service", collectionId: "col_1" });
	});

	test("a live issuer edit reports the services family", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool(
			"update_mock_issuer",
			{ issuerId: "issuer_1", failureMode: "slow" },
			ctx
		);
		expect(res.isError).toBeFalsy();
		// `issuerId` is not a scope hint: the drawer lists issuers together and
		// has no per-issuer cache to narrow to, so the family alone is the event.
		expect(onDataChanged).toHaveBeenCalledWith({ entity: "service" });
	});

	test("an issuer edit that named no field emits nothing - it never reached the engine", async () => {
		const client = fakeClient();
		const { ctx, onDataChanged } = ctxWithNotifier(client);
		const res = await dispatchTool("update_mock_issuer", { issuerId: "issuer_1" }, ctx);
		expect(res.isError).toBe(true);
		expect(client.updateMockIssuer).not.toHaveBeenCalled();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("a token fetch and a token clear report the oauth family", async () => {
		const acquired = ctxWithNotifier(fakeClient(), { allowlist: ["id.example.com"] });
		const fetched = await dispatchTool(
			"fetch_oauth2_token",
			{
				config: {
					grantType: "client_credentials",
					accessTokenUrl: "https://id.example.com/token",
					clientId: "client_a",
				},
			},
			acquired.ctx
		);
		expect(fetched.isError).toBeFalsy();
		// No scope hint: the key a fetch writes under is derived engine-side and
		// appears only in the answer, so the family is invalidated at its prefix.
		expect(acquired.onDataChanged).toHaveBeenCalledWith({ entity: "oauth" });

		const cleared = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("clear_oauth2_token", { cacheKey: "key_1" }, cleared.ctx);
		expect(res.isError).toBeFalsy();
		expect(cleared.onDataChanged).toHaveBeenCalledWith({ entity: "oauth" });
	});

	test("reading a token's status emits nothing", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient());
		const res = await dispatchTool("get_oauth2_token_status", { cacheKey: "key_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).not.toHaveBeenCalled();
	});

	test("an unconfirmed inbox delete emits nothing - nothing changed", async () => {
		const { ctx, onDataChanged } = ctxWithNotifier(fakeClient(), WRITES_ENABLED);
		const res = await dispatchTool("delete_webhook_inbox", { inboxId: "inbox_1" }, ctx);
		expect(res.isError).toBeFalsy();
		expect(onDataChanged).not.toHaveBeenCalled();
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
