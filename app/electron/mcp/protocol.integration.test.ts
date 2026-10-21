/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file protocol.integration.test.ts
 * @brief End-to-end protocol coverage: a real MCP SDK client performs the
 *        initialize -> tools/list -> tools/call handshake against the actual
 *        server (over an in-memory transport, deterministically), and the
 *        Streamable HTTP host is exercised for its transport-level behaviour
 *        (405 on GET, 404 off-path, DNS-rebinding rejection). The engine is
 *        mocked; no real network or Electron is involved.
 */

import http from "node:http";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
	Client,
	InMemoryTransport,
	StreamableHTTPClientTransport,
	type ElicitResult,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";
import { VayuMcpService } from "./index.js";
import { McpHttpServer, type McpHttpServerOptions } from "./http.js";
import { MCP_ENDPOINT_URL, MCP_HOST, MCP_PORT } from "../constants.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { TOOLS, toolCatalog, type ToolContext } from "./tools.js";
import { PROMPTS } from "./prompts.js";
import { STATIC_RESOURCES, RUN_REPORT_RESOURCE } from "./resources.js";
import type { EngineClient } from "./engine-client.js";
import type { Logger } from "../log.js";
import { freePort } from "./free-port.testkit.js";

const REPORT = {
	summary: { totalRequests: 100, errorCount: 1 },
	latency: { p50: 5, p95: 12, p99: 20 },
	statusCodes: { "200": 99, "500": 1 },
};

function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}): EngineClient {
	return {
		health: async () => ({ status: "ok", version: "9.9.9" }),
		getConfig: async () => ({ entries: [{ key: "workers", value: "8" }] }),
		getRunReport: async () => REPORT,
		// The paginated envelope the engine now returns (rows carry a summary).
		listRuns: async () => ({
			data: [{ id: "run_1" }, { id: "run_2" }],
			pagination: { total: 2, limit: 100, offset: 0, hasMore: false, returned: 2 },
		}),
		listCollections: async () => [{ id: "col_1", name: "API" }],
		listEnvironments: async () => [],
		listAllRequests: async () => [],
		getGlobals: async () => ({ variables: {} }),
		// The engine's completions shape, Monaco fields included - the resource is
		// expected to hand the agent the names and drop the editor scaffolding.
		getScriptCompletions: async () => ({
			version: "1.0.0",
			engine: "quickjs",
			completions: [
				{
					label: "pm.crypto.hmacSha256",
					kind: 1,
					insertText: "pm.crypto.hmacSha256(${1:key}, ${2:data})",
					insertTextRules: 4,
					sortText: "1_pm_crypto_hmacSha256",
					detail: "pm.crypto.hmacSha256(key, data, encoding?): string | Uint8Array",
					documentation: "HMAC-SHA256, hex by default. Synchronous.",
				},
			],
		}),
		// The same surface as declarations (issue #760), in the envelope
		// `GET /scripting/types` answers with.
		getScriptTypeDefinitions: async () => ({
			version: "1.0.0",
			engine: "quickjs",
			libUri: "ts:vayu/pm.d.ts",
			typeDefinitions:
				"declare namespace pm {\n  function test(name: string, fn: () => void): void;\n}\n",
		}),
		// Identity composition: the request echoed back, as the engine's
		// POST /compose returns for an inline request with nothing to resolve.
		composeRequest: async (body: { request?: object; environmentId?: string }) => ({
			...(body.request ?? {}),
			...(body.environmentId !== undefined ? { environmentId: body.environmentId } : {}),
		}),
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "running" }),
		...overrides,
	} as unknown as EngineClient;
}

function contextProvider(
	safety?: Partial<McpSafetyConfig>,
	client?: EngineClient
): () => ToolContext {
	return () => ({
		client: client ?? fakeClient(),
		config: resolveSafetyConfig(safety),
		host: "app",
	});
}

/** Connect a real SDK client to the Vayu server over a linked in-memory pair. */
async function connectClient(
	opts: {
		safety?: Partial<McpSafetyConfig>;
		client?: EngineClient;
		elicit?: (req: unknown) => ElicitResult;
	} = {}
) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer(
		{ name: "vayu", version: "test" },
		contextProvider(opts.safety, opts.client)
	);
	await server.connect(serverTransport);
	const client = new Client(
		{ name: "test-client", version: "1.0.0" },
		opts.elicit ? { capabilities: { elicitation: {} } } : undefined
	);
	if (opts.elicit) {
		const handler = opts.elicit;
		client.setRequestHandler("elicitation/create", async (req) => handler(req));
	}
	// connect() performs the initialize handshake.
	await client.connect(clientTransport);
	return { client, server };
}

describe("MCP protocol handshake (in-memory)", () => {
	it("lists the read, execute and load tools by default", async () => {
		const { client, server } = await connectClient();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("get_engine_health");
		expect(names).toContain("get_engine_config");
		expect(names).toContain("start_load_run");
		await server.close();
	});

	/*
	 * Writes ship off, and a write tool that cannot succeed does not ship its
	 * schema either: on a default install that is 28 of the 68 tools, described
	 * in full to an agent that can only be refused by them.
	 *
	 * Asserted from both sides, because only the pair shows the tools are
	 * *gated* rather than gone - a registration bug that dropped them
	 * unconditionally would pass the first of these alone.
	 */
	it("withholds write tools until write access is enabled", async () => {
		const off = await connectClient();
		const offNames = (await off.client.listTools()).tools.map((t) => t.name);
		const writeNames = TOOLS.filter((t) => t.category === "write").map((t) => t.name);
		expect(writeNames.length).toBeGreaterThan(20);
		expect(offNames.filter((n) => writeNames.includes(n))).toEqual([]);
		// The read/execute surface is untouched by the gate.
		expect(offNames).toContain("list_collections");
		expect(offNames).toContain("get_run");
		await off.server.close();

		const on = await connectClient({ safety: { allowWrites: true } });
		const onNames = (await on.client.listTools()).tools.map((t) => t.name);
		expect(writeNames.filter((n) => !onNames.includes(n))).toEqual([]);
		await on.server.close();
	});

	/*
	 * Withholding a write tool took its handler's refusal off the wire with it:
	 * the SDK rejects a name it never registered before any Vayu code runs, so
	 * an agent that guessed the name - from its own memory, or from a list it
	 * fetched while writes were on - got "not found" and nothing to ask the user
	 * for (#1431). The refusal is the one the handlers return, so the two
	 * cannot say different things about the same gate.
	 */
	it("answers a call to a withheld write tool with the refusal that names the setting", async () => {
		const { client, server } = await connectClient();
		const res = (await client.callTool({
			name: "create_collection",
			arguments: { name: "API" },
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/write access in Vayu Settings/i);
		expect(res.content[0].text).not.toMatch(/not found/i);
		await server.close();
	});

	/*
	 * The wrapper stands in front of the SDK's dispatch, so the other three
	 * categories must reach it unchanged - including a name that genuinely does
	 * not exist, which still gets the SDK's answer.
	 */
	it("leaves every other name to the SDK's dispatch while writes are off", async () => {
		const { client, server } = await connectClient();
		const ok = (await client.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(ok.isError).toBeFalsy();
		expect(ok.content[0].text).toContain("9.9.9");

		// The SDK rejects a name it has no tool for as invalid params (-32602).
		await expect(
			client.callTool({ name: "no_such_tool", arguments: {} })
		).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/not found/i) });
		await server.close();
	});

	/*
	 * A write tool the *user* switched off is unregistered for the other reason,
	 * and answering it with the write gate would send a user who enabled writes
	 * back to a tool that is still off. It keeps the disabled-tool answer.
	 */
	it("does not claim the write gate for a write tool switched off in Settings", async () => {
		const { client, server } = await connectClient({
			safety: { disabledTools: ["create_collection"] },
		});
		const call = client.callTool({ name: "create_collection", arguments: { name: "API" } });

		await expect(call).rejects.toMatchObject({ code: -32602 });
		await expect(call).rejects.not.toMatchObject({
			message: expect.stringMatching(/write access in Vayu Settings/i),
		});
		await server.close();
	});

	/*
	 * Settings lists every tool with a per-tool switch, so the catalog behind it
	 * must stay whole however the write toggle is set - otherwise turning writes
	 * off would silently empty the half of that list a user turns them back on
	 * from. `main.ts` also validates saved `disabledTools` names against it.
	 */
	it("keeps the Settings tool catalog complete regardless of the write toggle", () => {
		expect(toolCatalog().length).toBe(TOOLS.length);
		expect(toolCatalog().some((t) => t.category === "write")).toBe(true);
	});

	it("exposes Vayu's identity to the client (title / description / website + instructions)", async () => {
		const { client, server } = await connectClient();
		const info = client.getServerVersion();
		expect(info?.name).toBe("vayu");
		expect(info?.title).toBe("Vayu");
		expect(String(info?.description)).toMatch(/load-testing platform/i);
		expect(info?.websiteUrl).toContain("github.com/athrvk/vayu");
		expect(client.getInstructions()).toMatch(/API testing and load-testing/i);
		await server.close();
	});

	/*
	 * The instructions carry the cross-cutting facts - the capability taxonomy,
	 * the allowlist, the two gates - and deliberately name no tool. A roster
	 * here is a list of things that may not exist: the user can disable any
	 * tool individually, and this text used to end by telling the reader to
	 * trust `tools/list` over itself, which is the shape of the bug rather than
	 * a fix for it. Each tool's own description ships only when the tool does.
	 *
	 * `compare_runs` is exempt because it is also a prompt name, and the
	 * instructions legitimately point at the prompts - which nothing disables.
	 */
	it("names every resource the server registers in the instructions", async () => {
		const { client, server } = await connectClient();
		const instructions = client.getInstructions() ?? "";
		// Both sides must be non-empty or the loop below proves nothing.
		expect(STATIC_RESOURCES.length).toBeGreaterThan(5);
		for (const uri of [
			...STATIC_RESOURCES.map((r) => r.uri),
			RUN_REPORT_RESOURCE.uriTemplate,
		]) {
			expect(instructions).toContain(uri);
		}
		await server.close();
	});

	it("states the reference-line grammar and the two discovery rules in every session", async () => {
		const sessions = [{}, { allowWrites: true, revealSecretsToAgents: true }];
		for (const safety of sessions) {
			const { client, server } = await connectClient({ safety });
			const instructions = client.getInstructions() ?? "";
			expect(instructions).toContain('Vayu <kind> "<name>" (<id>)');
			expect(instructions).toMatch(/ask the user for a reference line/);
			expect(instructions).toMatch(
				/read by the runId its start call returned, not by its position in the run list/
			);
			await server.close();
		}
	});

	it("does not name individual tools in the server instructions", async () => {
		const { client, server } = await connectClient();
		const instructions = client.getInstructions() ?? "";
		// The guard is only meaningful if it read both sides of the comparison.
		expect(instructions.length).toBeGreaterThan(100);
		expect(TOOLS.length).toBeGreaterThan(20);

		const promptNames = new Set(PROMPTS.map((p) => p.name));
		const named = TOOLS.map((t) => t.name)
			.filter((name) => !promptNames.has(name))
			.filter((name) => new RegExp(`\\b${name}\\b`).test(instructions));

		expect(named).toEqual([]);
		await server.close();
	});

	/*
	 * The one cross-cutting fact a withheld tool's own description can no longer
	 * carry, because the description ships with the tool. It names the setting
	 * and no tool, and it ships only in the sessions it is true of - the server
	 * is rebuilt per request, so it cannot go stale against `tools/list`.
	 */
	it("states the write gate in the instructions only while writes are off", async () => {
		const off = await connectClient();
		expect(off.client.getInstructions() ?? "").toMatch(
			/write access is off in this session[\s\S]*Vayu Settings → MCP/i
		);
		await off.server.close();

		const on = await connectClient({ safety: { allowWrites: true } });
		const onInstructions = on.client.getInstructions() ?? "";
		expect(onInstructions).not.toMatch(/write access is off/i);
		// The rest of the text is one string either way.
		expect(onInstructions).toMatch(/grouped by capability/i);
		await on.server.close();
	});

	/*
	 * Written out here rather than imported from `server.ts`: a family deleted
	 * from the sentence must fail this table, and a table built from the same
	 * constant would shrink with it. Naming a family, never a tool, is the point:
	 * an agent that does not guess tool names concluded the MCP cannot save (#2442).
	 */
	const SAVE = "saving, editing, moving or deleting collections, requests and examples";
	const TRASH = "restoring or purging trashed items";
	const ENVIRONMENTS = "creating, editing, activating or deleting environments and globals";
	const IMPORT = "importing a document";
	const SPEC = "binding, syncing or unbinding an OpenAPI spec";
	const BASELINE = "pinning a run baseline";
	const RUNS = "deleting runs";
	const CLEARING = "clearing cookies, cached OAuth 2.0 tokens or webhook inbox captures";
	const INBOXES = "deleting webhook inboxes";
	const CONFIG = "changing engine config";

	const WRITE_TOOL_FAMILY: Record<string, string> = {
		create_collection: SAVE,
		update_collection: SAVE,
		delete_collection: SAVE,
		create_request: SAVE,
		update_request: SAVE,
		delete_request: SAVE,
		create_request_example: SAVE,
		update_request_example: SAVE,
		delete_request_example: SAVE,
		move_item: SAVE,
		restore_trash_entry: TRASH,
		purge_trash_entry: TRASH,
		create_environment: ENVIRONMENTS,
		update_environment: ENVIRONMENTS,
		activate_environment: ENVIRONMENTS,
		delete_environment: ENVIRONMENTS,
		update_globals: ENVIRONMENTS,
		import_document: IMPORT,
		bind_spec: SPEC,
		sync_spec: SPEC,
		unbind_spec: SPEC,
		set_run_baseline: BASELINE,
		delete_run: RUNS,
		clear_cookies: CLEARING,
		clear_oauth2_token: CLEARING,
		clear_inbox_captures: CLEARING,
		delete_webhook_inbox: INBOXES,
		update_engine_config: CONFIG,
	};

	it("classifies every write tool into a task family the write-gate sentence names", async () => {
		const writeTools = TOOLS.filter((t) => t.category === "write").map((t) => t.name);
		// Both sides must be non-empty or the comparison below proves nothing.
		expect(writeTools.length).toBeGreaterThan(20);
		expect([...writeTools].sort()).toEqual(Object.keys(WRITE_TOOL_FAMILY).sort());

		const off = await connectClient();
		const instructions = off.client.getInstructions() ?? "";
		await off.server.close();
		const unnamed = writeTools.filter(
			(name) => !instructions.includes(WRITE_TOOL_FAMILY[name])
		);
		expect(unnamed).toEqual([]);
	});

	it("names the task families that need write access only while writes are off", async () => {
		const families = [...new Set(Object.values(WRITE_TOOL_FAMILY))];
		expect(families.length).toBeGreaterThan(5);

		const off = await connectClient();
		const offInstructions = off.client.getInstructions() ?? "";
		await off.server.close();
		for (const family of families) expect(offInstructions).toContain(family);

		const on = await connectClient({ safety: { allowWrites: true } });
		const onInstructions = on.client.getInstructions() ?? "";
		await on.server.close();
		for (const family of families) expect(onInstructions).not.toContain(family);
	});

	it("says read tools withhold secrets, and names the setting only while it is off", async () => {
		const off = await connectClient();
		const offInstructions = off.client.getInstructions() ?? "";
		expect(offInstructions).not.toMatch(/always safe/i);
		expect(offInstructions).toMatch(/secret values withheld unless the user enables reveal/i);
		expect(offInstructions).toMatch(
			/secret values are withheld in this session[\s\S]*Reveal secrets to agents in Vayu Settings → MCP/i
		);
		await off.server.close();

		const on = await connectClient({ safety: { revealSecretsToAgents: true } });
		expect(on.client.getInstructions() ?? "").not.toMatch(/withheld in this session/i);
		await on.server.close();
	});

	it("exposes tool annotations (read-only / destructive hints + title)", async () => {
		const { client, server } = await connectClient();
		const { tools } = await client.listTools();
		const health = tools.find((t) => t.name === "get_engine_health");
		expect(health?.annotations).toMatchObject({
			title: "Check engine health",
			readOnlyHint: true,
		});
		const load = tools.find((t) => t.name === "start_load_run");
		expect(load?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		await server.close();
	});

	it("calls a tool and returns the engine response", async () => {
		const { client, server } = await connectClient();
		const res = (await client.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toContain("9.9.9");
		await server.close();
	});

	it("returns structured content for compare_runs (outputSchema)", async () => {
		const { client, server } = await connectClient();
		const { tools } = await client.listTools();
		expect(tools.find((t) => t.name === "compare_runs")?.outputSchema).toBeDefined();
		const res = (await client.callTool({
			name: "compare_runs",
			arguments: { baseRunId: "a", targetRunId: "b" },
		})) as { structuredContent?: { latency?: unknown[]; baseRunId?: string } };
		expect(res.structuredContent?.baseRunId).toBe("a");
		expect(Array.isArray(res.structuredContent?.latency)).toBe(true);
		await server.close();
	});

	it("omits a disabled tool from tools/list and rejects calling it", async () => {
		const { client, server } = await connectClient({
			safety: { disabledTools: ["get_engine_health"] },
		});
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).not.toContain("get_engine_health");
		// Unregistered → the SDK rejects it as invalid params ("tool not found").
		await expect(
			client.callTool({ name: "get_engine_health", arguments: {} })
		).rejects.toMatchObject({ code: -32602, message: expect.stringMatching(/not found/i) });
		await server.close();
	});

	it("uses elicitation to confirm a load run when the client supports it", async () => {
		const startRun = vi.fn().mockResolvedValue({ runId: "run_9", status: "running" });
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"], maxRps: 1000 },
			client: fakeClient({ startRun }),
			// Human accepts the elicitation prompt.
			elicit: () => ({ action: "accept", content: { proceed: true } }),
		});
		// No `confirmed` flag - confirmation comes from elicitation.
		const res = (await client.callTool({
			name: "start_load_run",
			arguments: { url: "https://api.example.com/x", mode: "constant_rps", targetRps: 50 },
		})) as { content: Array<{ text: string }>; isError?: boolean };
		expect(res.isError).toBeFalsy();
		expect(startRun).toHaveBeenCalledTimes(1);
		expect(res.content[0].text).not.toMatch(/AWAITING CONFIRMATION/);
		await server.close();
	});

	it("declines the load run when the user rejects the elicitation", async () => {
		const startRun = vi.fn();
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"], maxRps: 1000 },
			client: fakeClient({ startRun }),
			elicit: () => ({ action: "decline" }),
		});
		const res = (await client.callTool({
			name: "start_load_run",
			arguments: { url: "https://api.example.com/x", mode: "constant_rps", targetRps: 50 },
		})) as { content: Array<{ text: string }> };
		expect(startRun).not.toHaveBeenCalled();
		expect(res.content[0].text).toMatch(/declined/i);
		await server.close();
	});

	/*
	 * The stdio CLI's shape: one server for the whole connection, built before
	 * the handshake arrives, so the name is read from the SDK at send time.
	 */
	it("stamps a run with the client name its own handshake gave", async () => {
		const executeRequest = vi.fn().mockResolvedValue({ statusCode: 200 });
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"] },
			client: fakeClient({ executeRequest }),
		});
		await client.callTool({
			name: "run_request",
			arguments: { url: "https://api.example.com/x" },
		});
		expect(executeRequest.mock.calls[0][0]).toMatchObject({
			origin: { kind: "mcp", client: "test-client" },
		});
		await server.close();
	});
});

describe("resources", () => {
	it("lists the static resources", async () => {
		const { client, server } = await connectClient();
		const { resources } = await client.listResources();
		const uris = resources.map((r) => r.uri);
		expect(uris).toContain("vayu://runs");
		expect(uris).toContain("vayu://collections");
		expect(uris).toContain("vayu://environments");
		expect(uris).toContain("vayu://config");
		expect(uris).toContain("vayu://scripting/completions");
		expect(uris).toContain("vayu://scripting/types");
		expect(uris).toContain("vayu://elements/kinds");
		await server.close();
	});

	// Issue #233: an agent's only view of the sandbox used to be two sentences in
	// tool descriptions, so anything not named there was undiscoverable.
	it("serves the script sandbox surface from the engine, without Monaco's fields", async () => {
		const { client, server } = await connectClient();
		const res = await client.readResource({ uri: "vayu://scripting/completions" });
		const text = String((res.contents[0] as { text?: string }).text);
		expect(text).toContain("pm.crypto.hmacSha256");
		expect(text).toContain("Synchronous");
		expect(text).not.toContain("insertText");
		expect(text).not.toContain("sortText");
		await server.close();
	});

	// The other half of the same surface (issue #760): the names come from the
	// completions resource, the signatures from the engine's own declarations.
	it("serves the sandbox's type declarations from the engine", async () => {
		const { client, server } = await connectClient();
		const res = await client.readResource({ uri: "vayu://scripting/types" });
		const text = String((res.contents[0] as { text?: string }).text);
		expect(text).toContain("declare namespace pm");
		expect(text).toContain("ts:vayu/pm.d.ts");
		await server.close();
	});

	// Issue #1517: an agent building an `elements` list reads the registry
	// rather than guessing a kind's config shape.
	it("serves the element kind catalogue from the engine", async () => {
		const { client, server } = await connectClient({
			client: fakeClient({
				getElementKinds: async () => [
					{
						kind: "script.pre",
						category: "script",
						version: 1,
						phases: ["step.before"],
						label: "Pre-request script",
						description: "Runs before the request is sent.",
						hotPathClass: "script",
						configSchema: { type: "object", required: ["script"] },
					},
				],
			}),
		});
		const res = await client.readResource({ uri: "vayu://elements/kinds" });
		const text = String((res.contents[0] as { text?: string }).text);
		expect(text).toContain("script.pre");
		expect(text).toContain("Pre-request script");
		await server.close();
	});

	it("reads a static resource (vayu://runs)", async () => {
		const { client, server } = await connectClient();
		const res = await client.readResource({ uri: "vayu://runs" });
		expect(res.contents[0].mimeType).toBe("application/json");
		expect(String((res.contents[0] as { text?: string }).text)).toContain("run_1");
		await server.close();
	});

	/*
	 * The resources are a second read path to the same rows, so they withhold
	 * what the tools withhold (#1805) - otherwise `vayu://environments` is the
	 * bypass around `list_environments`. A stored row says so with a
	 * `...Withheld` marker; what a run recorded is masked in place (#1809).
	 */
	const RUN_SCOPE = {
		getGlobals: async () => ({ variables: { t: { value: "run-secret-7", secret: true } } }),
	};
	it.each([
		{
			uri: "vayu://environments",
			secret: "sk-live-123",
			marker: /Withheld/,
			overrides: {
				listEnvironments: async () => [
					{ id: "e", variables: { k: { value: "sk-live-123", secret: true } } },
				],
			},
		},
		{
			uri: "vayu://collections",
			secret: "hunter2",
			marker: /Withheld/,
			overrides: {
				listCollections: async () => [
					{ id: "c", auth: { mode: "basic", username: "me", password: "hunter2" } },
				],
			},
		},
		{
			uri: "vayu://config",
			secret: "alice:pw",
			marker: /Withheld/,
			overrides: {
				getConfig: async () => ({
					entries: [{ key: "proxyUrl", value: "http://alice:pw@proxy.corp:8080" }],
				}),
			},
		},
		{
			uri: "vayu://runs",
			secret: "run-secret-7",
			marker: /<redacted>/,
			overrides: {
				...RUN_SCOPE,
				listRuns: async () => ({
					data: [{ id: "run_1", summary: { url: "https://x.test/?k=run-secret-7" } }],
					pagination: { total: 1, limit: 100, offset: 0, hasMore: false, returned: 1 },
				}),
			},
		},
		{
			uri: "vayu://run/run_1/report",
			secret: "run-secret-7",
			marker: /<redacted>/,
			overrides: {
				...RUN_SCOPE,
				getRunReport: async () => ({
					...REPORT,
					results: [
						{
							id: 1,
							trace: {
								request: {
									url: "https://x.test/?k=run-secret-7",
									headers: { Authorization: "Bearer run-secret-7" },
									rawRequest:
										"GET /?k=run-secret-7 HTTP/1.1\r\nCookie: sid=run-secret-7",
								},
								response: { headers: { "Set-Cookie": "sid=run-secret-7" } },
							},
						},
					],
				}),
			},
		},
	])("$uri withholds a secret unless revealed", async ({ uri, secret, marker, overrides }) => {
		const text = async (safety?: Partial<McpSafetyConfig>) => {
			const { client, server } = await connectClient({
				safety,
				client: fakeClient(overrides),
			});
			const res = await client.readResource({ uri });
			await server.close();
			return String((res.contents[0] as { text?: string }).text);
		};
		const withheld = await text();
		expect(withheld).toMatch(marker);
		expect(withheld).not.toContain(secret);
		expect(await text({ revealSecretsToAgents: true })).toContain(secret);
	});

	it.each(["vayu://runs", "vayu://run/run_1/report"])(
		"%s fails the read when a secret lookup fails, rather than answer it partly masked",
		async (uri) => {
			const { client, server } = await connectClient({
				client: fakeClient({
					getGlobals: async () => {
						throw new Error("engine hiccup");
					},
				}),
			});
			await expect(client.readResource({ uri })).rejects.toThrow(
				/the globals lookup .*failed \(engine hiccup\)/
			);
			await server.close();
		}
	);

	it("exposes the run-report template and enumerates concrete runs", async () => {
		const { client, server } = await connectClient();
		const { resourceTemplates } = await client.listResourceTemplates();
		expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("vayu://run/{runId}/report");
		// The template's list callback enumerates concrete run reports.
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain("vayu://run/run_1/report");
		await server.close();
	});

	it("reads a templated run report", async () => {
		const { client, server } = await connectClient();
		const res = await client.readResource({ uri: "vayu://run/run_1/report" });
		expect(String((res.contents[0] as { text?: string }).text)).toContain("statusCodes");
		await server.close();
	});
});

/**
 * An engine call that never settles on its own, so the request is still in
 * flight when the client cancels it, and that records the `AbortSignal` it was
 * handed.
 *
 * `handed` staying undefined is the mutation check: drop the `extra.signal`
 * threading in `server.ts` and the first assertion of every test below fails
 * immediately, rather than the abort quietly never arriving.
 */
function hangingEngineCall() {
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	let markAborted!: () => void;
	const aborted = new Promise<void>((resolve) => (markAborted = resolve));
	let handed: AbortSignal | undefined;
	return {
		started,
		aborted,
		handedSignal: () => handed,
		call: (signal?: AbortSignal) =>
			new Promise<never>((_resolve, reject) => {
				handed = signal;
				markStarted();
				signal?.addEventListener("abort", () => {
					markAborted();
					reject(new Error("engine request aborted"));
				});
			}),
	};
}

/**
 * Cancellation has to reach the engine. Every resource / prompt definition
 * accepts an `AbortSignal` and forwards it to `EngineClient`, but for a while
 * only a unit test ever passed one: the SDK hands each callback a
 * handler context whose `ctx.mcpReq.signal` fires on `notifications/cancelled`, and
 * `server.ts` dropped it. A cancelled read left the engine request running
 * detached until the client's own 35s timeout.
 */
describe("client cancellation reaches the engine", () => {
	it("aborts the engine request for a static resource read", async () => {
		const hang = hangingEngineCall();
		const { client, server } = await connectClient({
			// Matching the real arity matters: `listRuns(query, signal)` hands
			// the signal second.
			client: fakeClient({
				listRuns: (_query: unknown, signal?: AbortSignal) => hang.call(signal),
			}),
		});
		const controller = new AbortController();
		const read = client.readResource({ uri: "vayu://runs" }, { signal: controller.signal });
		void read.catch(() => {});
		await hang.started;
		expect(hang.handedSignal(), "resource read got no signal from server.ts").toBeDefined();
		controller.abort();
		await hang.aborted;
		expect(hang.handedSignal()?.aborted).toBe(true);
		await server.close();
	});

	it("aborts the engine request for a templated run-report read", async () => {
		const hang = hangingEngineCall();
		const { client, server } = await connectClient({
			// Matching the real arity matters: `getRunReport(runId, signal)`
			// hands the signal second.
			client: fakeClient({
				getRunReport: (_runId: string, signal?: AbortSignal) => hang.call(signal),
			}),
		});
		const controller = new AbortController();
		const read = client.readResource(
			{ uri: "vayu://run/run_1/report" },
			{ signal: controller.signal }
		);
		void read.catch(() => {});
		await hang.started;
		expect(hang.handedSignal(), "template read got no signal from server.ts").toBeDefined();
		controller.abort();
		await hang.aborted;
		expect(hang.handedSignal()?.aborted).toBe(true);
		await server.close();
	});

	it("aborts the engine request behind the template's list callback", async () => {
		const hang = hangingEngineCall();
		const { client, server } = await connectClient({
			// Matching the real arity matters: `listRuns(query, signal)` hands
			// the signal second.
			client: fakeClient({
				listRuns: (_query: unknown, signal?: AbortSignal) => hang.call(signal),
			}),
		});
		const controller = new AbortController();
		const list = client.listResources(undefined, { signal: controller.signal });
		void list.catch(() => {});
		await hang.started;
		expect(hang.handedSignal(), "list callback got no signal from server.ts").toBeDefined();
		controller.abort();
		await hang.aborted;
		expect(hang.handedSignal()?.aborted).toBe(true);
		await server.close();
	});

	it("aborts the engine request behind a prompt", async () => {
		const hang = hangingEngineCall();
		const { client, server } = await connectClient({
			// Matching the real arity matters: `getRunReport(runId, signal)`
			// hands the signal second.
			client: fakeClient({
				getRunReport: (_runId: string, signal?: AbortSignal) => hang.call(signal),
			}),
		});
		const controller = new AbortController();
		const prompt = client.getPrompt(
			{ name: "summarize_run", arguments: { runId: "run_1" } },
			{ signal: controller.signal }
		);
		void prompt.catch(() => {});
		await hang.started;
		expect(hang.handedSignal(), "prompt build got no signal from server.ts").toBeDefined();
		controller.abort();
		await hang.aborted;
		expect(hang.handedSignal()?.aborted).toBe(true);
		await server.close();
	});
});

describe("prompts", () => {
	it("lists the server-provided prompts", async () => {
		const { client, server } = await connectClient();
		const { prompts } = await client.listPrompts();
		const names = prompts.map((p) => p.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"summarize_run",
				"compare_runs",
				"diagnose_errors",
				"suggest_load_profile",
			])
		);
		await server.close();
	});

	it("builds summarize_run with the run report embedded", async () => {
		const { client, server } = await connectClient();
		const res = await client.getPrompt({
			name: "summarize_run",
			arguments: { runId: "run_1" },
		});
		const text = res.messages[0].content.type === "text" ? res.messages[0].content.text : "";
		expect(text).toMatch(/summarize this vayu run/i);
		expect(text).toContain("statusCodes");
		await server.close();
	});

	it("builds suggest_load_profile without needing engine data", async () => {
		const { client, server } = await connectClient();
		const res = await client.getPrompt({
			name: "suggest_load_profile",
			arguments: { url: "https://api.example.com", goal: "find the breaking point" },
		});
		const text = res.messages[0].content.type === "text" ? res.messages[0].content.text : "";
		expect(text).toContain("https://api.example.com");
		expect(text).toMatch(/breaking point/i);
		await server.close();
	});
});

describe("Streamable HTTP host", () => {
	const HOST = "127.0.0.1";
	// A fresh port per test, from the OS: a fixed number fails whenever anything
	// else on the runner holds it.
	let activePort = 0;
	let httpServer: McpHttpServer | null = null;

	afterEach(async () => {
		await httpServer?.stop();
		httpServer = null;
	});

	async function start(
		safety?: Partial<McpSafetyConfig>,
		extra: Partial<McpHttpServerOptions> = {}
	) {
		activePort = await freePort();
		httpServer = new McpHttpServer({
			host: HOST,
			port: activePort,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(safety),
			...extra,
		});
		await httpServer.start();
	}

	/**
	 * Raw JSON-RPC request with full header control (fetch can't forge Host).
	 * Resolves `{ status, json }`; on a dropped connection resolves status 0 so
	 * callers can treat "rejected" uniformly whether the server errors or hangs up.
	 */
	function request(opts: {
		method?: string;
		path?: string;
		host?: string;
		accept?: string;
		body?: unknown;
		/** Sent verbatim - the only way to post a body that is not valid JSON. */
		rawBody?: string;
	}): Promise<{ status: number; json: unknown }> {
		return new Promise((resolve) => {
			const data = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
			const req = http.request(
				{
					host: HOST,
					port: activePort,
					path: opts.path ?? "/mcp",
					method: opts.method ?? "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: opts.accept ?? "application/json, text/event-stream",
						"Content-Length": Buffer.byteLength(data),
						...(opts.host ? { Host: opts.host } : {}),
					},
				},
				(res) => {
					let out = "";
					res.on("data", (d) => (out += d));
					res.on("end", () => {
						resolve({ status: res.statusCode ?? 0, json: parseAnswer(out) });
					});
				}
			);
			req.on("error", () => resolve({ status: 0, json: undefined }));
			// The host answers an oversized upload while it is still arriving and
			// closes the connection once it has drained, so the rest of the write
			// can fail with EPIPE after the answer was read. By then the request
			// has let go of its socket, and an error with no listener is an
			// uncaught exception that fails the whole run.
			req.on("socket", (socket) => socket.on("error", () => {}));
			if (data) req.write(data);
			req.end();
		});
	}

	/**
	 * A JSON-RPC answer as either shape the host sends it: a JSON body, or the
	 * `data:` line of the event stream a 2025-era request is answered on.
	 */
	function parseAnswer(text: string): unknown {
		const event = text.split("\n").find((line) => line.startsWith("data: "));
		try {
			return JSON.parse(event ? event.slice("data: ".length) : text);
		} catch {
			return undefined;
		}
	}

	const initBody = {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "raw", version: "1.0.0" },
		},
	};

	/**
	 * The URL the host serves and the URL the app hands out have to be the same
	 * string. They were assembled from three separate `/mcp` literals - the path
	 * served here, `MCP_ENDPOINT_URL`, and a renderer default - with nothing
	 * holding them together; the path now comes from `MCP_PATH` and the renderer
	 * is told the live URL over `mcp:status`.
	 */
	it("serves exactly the endpoint the app advertises", () => {
		const server = new McpHttpServer({
			host: MCP_HOST,
			port: MCP_PORT,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(),
		});
		expect(server.url).toBe(MCP_ENDPOINT_URL);
	});

	it("rejects GET with 405 (POST-only endpoint)", async () => {
		await start();
		const res = await request({ method: "GET", body: undefined });
		expect(res.status).toBe(405);
	});

	it("returns 404 for a non-/mcp path", async () => {
		await start();
		const res = await request({ method: "GET", path: "/nope", body: undefined });
		expect(res.status).toBe(404);
	});

	it("answers a real initialize over HTTP", async () => {
		await start();
		const res = await request({ body: initBody });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({
			jsonrpc: "2.0",
			result: { serverInfo: { name: "vayu" } },
		});
	});

	/**
	 * A client-side payload mistake used to come back as HTTP 500 / -32603
	 * "Internal error" - the shape of a server that fell over, sending the
	 * client to check whether Vayu is alive instead of at its own JSON.
	 */
	it("answers a handler that throws with a fixed -32603 and logs the cause", async () => {
		const log = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
		await start(undefined, {
			log,
			contextProvider: () => {
				throw new Error("secret detail at /home/user/.vayu");
			},
		});
		const res = await request({ body: initBody });
		expect(res.status).toBe(500);
		// The SDK's handler answers it now, with its own fixed message and the
		// request's id; what matters is the code and that nothing leaks.
		expect(res.json).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32603, message: "Internal server error" },
		});
		expect(JSON.stringify(res.json)).not.toContain("secret detail");
		expect(log.error).toHaveBeenCalledWith(
			"mcp",
			expect.any(String),
			expect.objectContaining({
				path: "/mcp",
				error: expect.stringContaining("secret detail at /home/user/.vayu"),
			})
		);
	});

	it("answers malformed JSON with 400 / -32700, not a 500", async () => {
		await start();
		const res = await request({ rawBody: '{"jsonrpc":"2.0", "id":1,' });
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32700 },
		});
		expect(JSON.stringify(res.json)).not.toMatch(/Internal error/);
		// The message is a literal written at the throw site. Nothing derived
		// from the underlying error reaches the wire: this response goes to
		// anyone who can reach the endpoint, and `readJsonBody` also rejects
		// with the socket's own error, which is not the client's to read.
		expect(res.json).toMatchObject({
			error: { message: "Parse error: the request body is not valid JSON." },
		});
	});

	it("answers an oversized body with 413 / -32600, not a parse error", async () => {
		await start();
		// Valid JSON, over the 4 MB cap - so a 400 "not valid JSON" would send
		// the client rewriting a body that was never the problem.
		const res = await request({
			rawBody: JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) }),
		});
		expect(res.status).toBe(413);
		expect(res.json).toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32600 },
		});
	});

	it("still serves a valid body after a malformed one on the same server", async () => {
		await start();
		await request({ rawBody: "not json at all" });
		const res = await request({ body: initBody });
		expect(res.status).toBe(200);
	});

	it("rejects a forged Host header (DNS-rebinding protection)", async () => {
		await start();
		const res = await request({ host: "evil.example.com", body: initBody });
		expect(res.status).toBe(403);
	});
});

/**
 * The production path: a real MCP SDK client driving the stateless Streamable
 * HTTP host over a real socket - the transport agents (Claude Code / Cursor)
 * actually use. Proves the full initialize -> tools/list -> tools/call round-trip
 * works over HTTP (not just the in-memory transport), and that the safety guards
 * apply on this transport too.
 */
describe("Streamable HTTP host - real SDK client end-to-end", () => {
	const HOST = "127.0.0.1";
	let httpServer: McpHttpServer | null = null;
	let client: Client | null = null;

	afterEach(async () => {
		await client?.close().catch(() => {});
		client = null;
		await httpServer?.stop();
		httpServer = null;
	});

	async function host(opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}) {
		const port = await freePort();
		httpServer = new McpHttpServer({
			host: HOST,
			port,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(opts.safety, opts.client),
		});
		await httpServer.start();
		return port;
	}

	async function connect(
		opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}
	) {
		const port = await host(opts);
		const c = new Client({ name: "http-e2e", version: "1.0.0" });
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		client = c;
		return c;
	}

	/** One JSON-RPC POST from a client that manages its own headers. */
	function post(port: number, body: unknown, headers: Record<string, string> = {}) {
		return fetch(`http://${HOST}:${port}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify(body),
		});
	}

	it("initialize + tools/list + tools/call over real HTTP", async () => {
		const c = await connect();

		// Identity survives the HTTP handshake.
		expect(c.getServerVersion()?.name).toBe("vayu");

		const { tools } = await c.listTools();
		expect(tools.map((t) => t.name)).toContain("get_engine_health");

		// The real payload proves it's not just transport-level: a tool call on a
		// fresh, stateless per-request server returns the (mock) engine response.
		const res = (await c.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toContain("9.9.9");
	});

	it("returns structured content over HTTP (compare_runs outputSchema)", async () => {
		const c = await connect();
		const res = (await c.callTool({
			name: "compare_runs",
			arguments: { baseRunId: "a", targetRunId: "b" },
		})) as { structuredContent?: { baseRunId?: string } };
		expect(res.structuredContent?.baseRunId).toBe("a");
	});

	it("enforces the empty-default allowlist over HTTP (run_request blocked)", async () => {
		const c = await connect();
		const res = (await c.callTool({
			name: "run_request",
			arguments: { url: "https://api.example.com/x" },
		})) as { content: Array<{ text: string }>; isError?: boolean };
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/allowlist is empty/i);
	});

	it("omits a disabled tool from tools/list over HTTP", async () => {
		const c = await connect({ safety: { disabledTools: ["get_engine_health"] } });
		const { tools } = await c.listTools();
		expect(tools.map((t) => t.name)).not.toContain("get_engine_health");
	});

	/*
	 * Every request reaches a fresh server, so the one that read the handshake
	 * is gone by the first `tools/call`: the name crosses requests only through
	 * the session id the host issued and the SDK client echoes (#1817).
	 */
	it("stamps runs with the client name from the handshake", async () => {
		const executeRequest = vi.fn().mockResolvedValue({ statusCode: 200 });
		const startRun = vi.fn().mockResolvedValue({ runId: "run_1", status: "running" });
		const c = await connect({
			safety: { allowlist: ["api.example.com"] },
			client: fakeClient({ executeRequest, startRun }),
		});
		await c.callTool({ name: "run_request", arguments: { url: "https://api.example.com/x" } });
		await c.callTool({
			name: "start_load_run",
			arguments: { url: "https://api.example.com/x", confirmed: true },
		});

		const named = { kind: "mcp", client: "http-e2e" };
		expect(executeRequest.mock.calls[0][0]).toMatchObject({ origin: named });
		expect(startRun.mock.calls[0][0]).toMatchObject({ origin: named });
	});

	it("a request without the issued session id starts an unnamed MCP run", async () => {
		const executeRequest = vi.fn().mockResolvedValue({ statusCode: 200 });
		const port = await host({
			safety: { allowlist: ["api.example.com"] },
			client: fakeClient({ executeRequest }),
		});
		const init = await post(port, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "raw-client", version: "1.0.0" },
			},
		});
		const issued = init.headers.get("mcp-session-id");
		expect(issued).toMatch(/^[0-9a-f-]{36}$/);

		const call = {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "run_request", arguments: { url: "https://api.example.com/x" } },
		};
		const unnamed: Array<Record<string, string>> = [{}, { "mcp-session-id": "never-issued" }];
		for (const headers of unnamed) {
			expect((await post(port, call, headers)).status).toBe(200);
		}
		await post(port, call, { "mcp-session-id": issued! });

		expect(executeRequest.mock.calls.map(([payload]) => payload.origin)).toStrictEqual([
			{ kind: "mcp" },
			{ kind: "mcp" },
			{ kind: "mcp", client: "raw-client" },
		]);
	});
});

/*
 * A 2026-07-28 client reaches the same factory through the same endpoint, and
 * gets what the 2025-era stateless leg cannot give: a question put to the
 * person over HTTP, and word when the tool list changes.
 */
describe("Streamable HTTP host - 2026-07-28 clients", () => {
	const HOST = "127.0.0.1";
	let httpServer: McpHttpServer | null = null;
	let service: VayuMcpService | null = null;
	const clients: Client[] = [];

	afterEach(async () => {
		for (const c of clients.splice(0)) await c.close().catch(() => {});
		await httpServer?.stop();
		httpServer = null;
		await service?.stop();
		service = null;
	});

	async function host(opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}) {
		const port = await freePort();
		httpServer = new McpHttpServer({
			host: HOST,
			port,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(opts.safety, opts.client),
		});
		await httpServer.start();
		return port;
	}

	/** A client on @p port; `modern` probes for 2026-07-28, otherwise it speaks 2025. */
	async function connectTo(
		port: number,
		opts: { modern: boolean; elicit?: (req: unknown) => ElicitResult }
	) {
		const c = new Client(
			{ name: opts.modern ? "modern-e2e" : "legacy-e2e", version: "1.0.0" },
			{
				...(opts.modern ? { versionNegotiation: { mode: "auto" as const } } : {}),
				...(opts.elicit ? { capabilities: { elicitation: {} } } : {}),
			}
		);
		if (opts.elicit) {
			const answer = opts.elicit;
			c.setRequestHandler("elicitation/create", async (req) => answer(req));
		}
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		clients.push(c);
		return c;
	}

	const loadCall = {
		name: "start_load_run",
		arguments: { url: "https://api.example.com/x", mode: "constant_rps", targetRps: 50 },
	};
	const loadSafety = { allowlist: ["api.example.com"], maxRps: 1000 };

	it("negotiates 2026-07-28 and serves tools and the server's identity", async () => {
		const port = await host();
		const c = await connectTo(port, { modern: true });
		expect(c.getProtocolEra()).toBe("modern");
		const identity = c.getServerVersion();
		expect(identity?.name).toBe("vayu");
		expect(identity?.icons?.[0]?.src).toMatch(/^data:image\/png;base64,/);
		const res = (await c.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
		};
		expect(res.content[0].text).toContain("9.9.9");
	});

	it("names the server's icon to a 2025-era client too", async () => {
		const port = await host();
		const c = await connectTo(port, { modern: false });
		expect(c.getProtocolEra()).toBe("legacy");
		expect(c.getServerVersion()?.icons?.[0]?.mimeType).toBe("image/png");
	});

	/*
	 * The one transport that used to fall back to the flag every time: a
	 * stateless server could not carry the person's answer back to itself. The
	 * question now travels in-band and the call is retried with the answer.
	 */
	it("asks the person over HTTP, and acts on their yes", async () => {
		const startRun = vi.fn().mockResolvedValue({ runId: "run_9", status: "running" });
		const port = await host({ safety: loadSafety, client: fakeClient({ startRun }) });
		const asked: string[] = [];
		const c = await connectTo(port, {
			modern: true,
			elicit: (req) => {
				asked.push((req as { params: { message: string } }).params.message);
				return { action: "accept", content: { proceed: true } };
			},
		});
		const res = (await c.callTool(loadCall)) as { content: Array<{ text: string }> };
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatch(/api\.example\.com/);
		expect(startRun).toHaveBeenCalledTimes(1);
		expect(res.content[0].text).not.toMatch(/AWAITING CONFIRMATION/);
	});

	/*
	 * Declaring only URL-mode elicitation is declaring no form questions: asking
	 * one would be refused as a protocol error, so the client gets the flag.
	 */
	it("falls back to the confirmed flag for a client that only takes URL questions", async () => {
		const startRun = vi.fn();
		const port = await host({ safety: loadSafety, client: fakeClient({ startRun }) });
		const c = new Client(
			{ name: "url-only", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" }, capabilities: { elicitation: { url: {} } } }
		);
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		clients.push(c);
		const res = (await c.callTool(loadCall)) as { content: Array<{ text: string }> };
		expect(startRun).not.toHaveBeenCalled();
		expect(res.content[0].text).toMatch(/AWAITING CONFIRMATION/);
	});

	it("starts nothing when the person declines over HTTP", async () => {
		const startRun = vi.fn();
		const port = await host({ safety: loadSafety, client: fakeClient({ startRun }) });
		const c = await connectTo(port, { modern: true, elicit: () => ({ action: "decline" }) });
		const res = (await c.callTool(loadCall)) as { content: Array<{ text: string }> };
		expect(startRun).not.toHaveBeenCalled();
		expect(res.content[0].text).toMatch(/declined/i);
	});

	/*
	 * Asking a client that declared no elicitation is a protocol error the tool
	 * cannot catch (-32021), so such a client gets the preview and the flag.
	 */
	it("falls back to the confirmed flag for a 2026-07-28 client that cannot be asked", async () => {
		const startRun = vi.fn();
		const port = await host({ safety: loadSafety, client: fakeClient({ startRun }) });
		const c = await connectTo(port, { modern: true });
		const res = (await c.callTool(loadCall)) as { content: Array<{ text: string }> };
		expect(startRun).not.toHaveBeenCalled();
		expect(res.content[0].text).toMatch(/AWAITING CONFIRMATION/);
	});

	/*
	 * A 2025-era client over HTTP declared elicitation to a server that is gone
	 * by its first call; asking it would be refused, so it gets the flag.
	 */
	it("falls back to the confirmed flag for a 2025-era client over HTTP", async () => {
		const startRun = vi.fn();
		const elicit = vi.fn();
		const port = await host({ safety: loadSafety, client: fakeClient({ startRun }) });
		const c = await connectTo(port, { modern: false, elicit });
		const res = (await c.callTool(loadCall)) as { content: Array<{ text: string }> };
		expect(elicit).not.toHaveBeenCalled();
		expect(startRun).not.toHaveBeenCalled();
		expect(res.content[0].text).toMatch(/AWAITING CONFIRMATION/);
	});

	it("stamps a run with the name a 2026-07-28 client gives on each request", async () => {
		const executeRequest = vi.fn().mockResolvedValue({ statusCode: 200 });
		const port = await host({
			safety: { allowlist: ["api.example.com"] },
			client: fakeClient({ executeRequest }),
		});
		const c = await connectTo(port, { modern: true });
		await c.callTool({ name: "run_request", arguments: { url: "https://api.example.com/x" } });
		expect(executeRequest.mock.calls[0][0]).toMatchObject({
			origin: { kind: "mcp", client: "modern-e2e" },
		});
	});

	/*
	 * Advertised only where it can be kept: a 2025-era client of this host has
	 * no stream to be told on.
	 */
	it("advertises tool-list changes to a 2026-07-28 client and not to a 2025-era one", async () => {
		const port = await host();
		const modern = await connectTo(port, { modern: true });
		const legacy = await connectTo(port, { modern: false });
		expect(modern.getServerCapabilities()?.tools?.listChanged).toBe(true);
		expect(legacy.getServerCapabilities()?.tools?.listChanged).toBe(false);
		// Nothing announces a resource or prompt list change, to anyone.
		for (const c of [modern, legacy]) {
			expect(c.getServerCapabilities()?.resources?.listChanged).toBe(false);
			expect(c.getServerCapabilities()?.prompts?.listChanged).toBe(false);
		}
	});

	it("tells a listening client when a Settings change alters tools/list", async () => {
		const port = await freePort();
		service = new VayuMcpService({
			engineBaseUrl: "http://127.0.0.1:1",
			host: HOST,
			port,
			version: "test",
		});
		await service.start();
		const c = await connectTo(port, { modern: true });
		let changed = 0;
		c.setNotificationHandler("notifications/tools/list_changed", async () => {
			changed++;
		});
		const subscription = await c.listen({ toolsListChanged: true });
		expect(subscription.honoredFilter.toolsListChanged).toBe(true);

		// A change that leaves the list as it was says nothing.
		service.updateSafety({ maxRps: 10 });
		service.updateSafety({ allowWrites: true });
		await vi.waitFor(() => expect(changed).toBeGreaterThan(0));
		const { tools } = await c.listTools();
		expect(tools.map((t) => t.name)).toContain("create_collection");
		// One stream, in order: a notice for the first change would have come
		// before the one just counted.
		expect(changed).toBe(1);

		// Same names, different descriptions: revealing drops each withheld
		// pointer from them (#2441), and a client holding the old list reads
		// rules that no longer apply.
		const before = await c.listTools();
		service.updateSafety({ revealSecretsToAgents: true });
		await vi.waitFor(() => expect(changed).toBe(2));
		const after = await c.listTools();
		expect(after.tools.map((t) => t.name)).toEqual(before.tools.map((t) => t.name));
		expect(after.tools.map((t) => t.description)).not.toEqual(
			before.tools.map((t) => t.description)
		);
		await subscription.close();
	});

	/*
	 * A listen stream stays open for as long as the client likes; stopping the
	 * host ends it rather than waiting on it (MCP switched off, the app quitting).
	 */
	it("stops while a client holds a listen stream open", async () => {
		const port = await host();
		const c = await connectTo(port, { modern: true });
		const subscription = await c.listen({ toolsListChanged: true });
		const stopped = httpServer!.stop().then(() => "stopped");
		// A healthy stop takes milliseconds; the bound only has to outlast a
		// runner that stalls the event loop, not a stream that is never ended.
		const waited = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 15_000));
		expect(await Promise.race([stopped, waited])).toBe("stopped");
		httpServer = null;
		expect(await subscription.closed).not.toBe("local");
	});

	it("refuses a request a browser page sent from another origin", async () => {
		const port = await host();
		const res = await fetch(`http://${HOST}:${port}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Origin: "https://evil.example",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "page", version: "1" },
				},
			}),
		});
		expect(res.status).toBe(403);
	});
});

/*
 * The stdio CLI's entry, driven over a linked pair in place of the process's
 * pipes. A 2026-07-28 connection carries no handshake, so who the client is and
 * whether it can be asked come from each request's own envelope.
 */
describe("stdio entry (serveStdio)", () => {
	async function serve(opts: { client?: EngineClient; safety?: Partial<McpSafetyConfig> }) {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const handle = serveStdio(
			() =>
				createMcpServer(
					{ name: "vayu", version: "test" },
					contextProvider(opts.safety, opts.client)
				),
			{ transport: serverTransport }
		);
		return { clientTransport, handle };
	}

	it("asks the person on a 2026-07-28 connection and names the client", async () => {
		const startRun = vi.fn().mockResolvedValue({ runId: "run_9", status: "running" });
		const { clientTransport, handle } = await serve({
			safety: { allowlist: ["api.example.com"], maxRps: 1000 },
			client: fakeClient({ startRun }),
		});
		const c = new Client(
			{ name: "stdio-modern", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" }, capabilities: { elicitation: {} } }
		);
		const elicit = vi.fn().mockResolvedValue({ action: "accept", content: { proceed: true } });
		c.setRequestHandler("elicitation/create", async (req) => elicit(req));
		await c.connect(clientTransport);
		expect(c.getProtocolEra()).toBe("modern");

		await c.callTool({
			name: "start_load_run",
			arguments: { url: "https://api.example.com/x", mode: "constant_rps", targetRps: 50 },
		});
		expect(elicit).toHaveBeenCalledTimes(1);
		expect(startRun).toHaveBeenCalledTimes(1);
		expect(startRun.mock.calls[0][0]).toMatchObject({
			origin: { kind: "mcp", client: "stdio-modern" },
		});
		await c.close();
		await handle.close();
	});
});
