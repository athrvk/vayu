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
import net from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
	Client,
	InMemoryTransport,
	ProtocolError,
	StreamableHTTPClientTransport,
	type ElicitResult,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.js";
import { VayuMcpService } from "./index.js";
import { McpHttpServer, type McpHttpServerOptions } from "./http.js";
import { InFlightCalls } from "./in-flight-calls.js";
import { CALL_CANCELLED, CUT_ERROR_CODE, SERVER_STOPPED } from "./held-exchange.js";
import { McpListener } from "./listener.js";
import { createMcpLifecycle, type McpLifecycle } from "./lifecycle.js";
import { MCP_HOST, MCP_PORT, mcpEndpointUrl } from "../constants.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { TOOLS, isListed, toolCatalog, type ToolContext } from "./tools.js";
import { PROMPTS } from "./prompts.js";
import { STATIC_RESOURCES, RUN_REPORT_RESOURCE } from "./resources.js";
import { VARIABLE_PRECEDENCE_SENTENCE, VARIABLE_RESOLUTION_MODEL } from "./variable-origins.js";
import { EngineRequestError, type EngineClient } from "./engine-client.js";
import type { Logger } from "../log.js";
import { freePort } from "./free-port.testkit.js";
import { ASYNC_UTIL_TIMEOUT_MS, TEST_TIMEOUT_MS } from "@/test/timeouts";

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

	/*
	 * #3559: a client that reads no resources never sees
	 * `vayu://variables/resolution`, and no tool serves it, so the rules a tool's
	 * pointer leads to are stated where every client reads.
	 */
	it("states the variable resolution order and rules in the instructions", async () => {
		const { client, server } = await connectClient();
		const instructions = client.getInstructions() ?? "";
		expect(VARIABLE_RESOLUTION_MODEL.rules.length).toBeGreaterThan(0);
		for (const rule of [VARIABLE_PRECEDENCE_SENTENCE, ...VARIABLE_RESOLUTION_MODEL.rules]) {
			expect(instructions).toContain(rule);
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

	/*
	 * An error's `structuredContent` is `{ error }`, which no tool's
	 * outputSchema describes: it reaches the client only because the SDK holds
	 * a success, not an error, to that schema (#2776).
	 */
	it("delivers an error's failure class through an outputSchema tool", async () => {
		const { client, server } = await connectClient({
			client: fakeClient({
				getRunReport: vi
					.fn()
					.mockRejectedValue(new TypeError("fetch failed: connect ECONNREFUSED")),
			}),
		});
		await client.listTools();
		const res = (await client.callTool({
			name: "compare_runs",
			arguments: { baseRunId: "a", targetRunId: "b" },
		})) as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: unknown };
		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({
			error: { class: "unreachable", retryable: true, advice: res.content[0].text },
		});
		await server.close();
	});

	/*
	 * The SDK refuses a wrongly typed argument itself, before dispatch runs, so
	 * the class comes from the wrapper in front of its handler. An error
	 * dispatch answered passes that wrapper as it was.
	 */
	it("classes an argument the SDK's schema check refused as input", async () => {
		const { client, server } = await connectClient({ safety: { allowWrites: true } });
		const res = (await client.callTool({ name: "get_run", arguments: { runId: 5 } })) as {
			isError?: boolean;
			content: Array<{ text: string }>;
			structuredContent?: unknown;
		};
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/^Input validation error/);
		expect(res.structuredContent).toEqual({
			error: { class: "input", retryable: false, advice: res.content[0].text },
		});
		await server.close();
	});

	it("leaves an error dispatch answered as dispatch answered it", async () => {
		const { client, server } = await connectClient({
			client: fakeClient({
				getRun: vi
					.fn()
					.mockRejectedValue(
						new EngineRequestError("Engine responded 404", 404, "Run not found")
					),
			}),
		});
		const res = (await client.callTool({
			name: "get_run",
			arguments: { runId: "run_gone" },
		})) as { content: Array<{ text: string }>; structuredContent?: unknown };
		// get_run names the id and the list tool in place of the engine's body.
		const text =
			'No run with id "run_gone" (it may have been deleted or the id is mistyped). ' +
			"List runs with list_runs.";
		expect(res.content).toEqual([{ type: "text", text }]);
		expect(res.structuredContent).toEqual({
			error: { class: "not_found", retryable: false, advice: text },
		});
		await server.close();
	});

	it("classes the refusal of a withheld write tool as policy", async () => {
		const { client, server } = await connectClient();
		const res = (await client.callTool({
			name: "create_collection",
			arguments: { name: "API" },
		})) as { structuredContent?: { error?: { class?: string } } };
		expect(res.structuredContent?.error?.class).toBe("policy");
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

/**
 * An argument a tool does not declare is refused by name, never dropped
 * (#3556). Dropped, a misspelt `collection_id` read every run in the workspace
 * and a nested `scenario.iterations` started a run of another length, each with
 * nothing said to the agent. The SDK answers before any handler runs, so the
 * engine client here records every call and must record none.
 */
describe("undeclared arguments", () => {
	const UNKNOWN = "notAnArgument";
	/** Every tool listed: write tools are withheld otherwise, and would answer the write gate instead. */
	const EVERY_TOOL: Partial<McpSafetyConfig> = { allowWrites: true };

	interface CallAnswer {
		isError?: boolean;
		content: Array<{ text: string }>;
		structuredContent?: { error?: { class?: string } };
	}

	/** An engine client that records each method called on it, answering every one with `{}`. */
	function recordingClient() {
		const called: string[] = [];
		const client = new Proxy(
			{},
			{
				get: (_target, method) =>
					// Not a thenable, so nothing that awaits the client hangs on it.
					typeof method !== "string" || method === "then"
						? undefined
						: () => {
								called.push(method);
								return Promise.resolve({});
							},
			}
		) as EngineClient;
		return { client, called };
	}

	async function call(name: string, args: Record<string, unknown>) {
		const engine = recordingClient();
		const { client, server } = await connectClient({
			safety: EVERY_TOOL,
			client: engine.client,
		});
		const answer = (await client.callTool({ name, arguments: args })) as CallAnswer;
		await server.close();
		return { answer, called: engine.called };
	}

	function expectRefusedNaming(
		{ answer, called }: Awaited<ReturnType<typeof call>>,
		refusal: string
	) {
		expect(answer.isError).toBe(true);
		expect(answer.structuredContent?.error?.class).toBe("input");
		expect(answer.content[0].text).toContain(refusal);
		expect(called).toEqual([]);
	}

	const listed = TOOLS.filter((tool) => isListed(tool, resolveSafetyConfig(EVERY_TOOL)));

	it("covers every tool in the registry", () => {
		expect(listed.length).toBe(TOOLS.length);
	});

	// Mutation check: `z.object` for `argumentsSchema` in server.ts fails every
	// row - a tool with a required argument answers without naming the key, and
	// one without runs its handler and reaches the engine.
	it.each(listed.map((tool) => tool.name))(
		"%s refuses an undeclared argument by name and reaches no engine",
		async (name) => {
			expectRefusedNaming(
				await call(name, { [UNKNOWN]: true }),
				`Unrecognized key: "${UNKNOWN}"`
			);
		}
	);

	it("list_runs refuses a snake_case collection_id rather than listing every run", async () => {
		expectRefusedNaming(
			await call("list_runs", { collection_id: "x" }),
			'Unrecognized key: "collection_id"'
		);
	});

	// `GET /runs` leaves a filter it cannot parse unset, so the app's own
	// spelling "not-judged" would answer every run, read as "nothing matched".
	// Mutation check: declare `outcome` as `z.string()` and this reaches the engine.
	it("list_runs refuses an outcome the engine would ignore (#3547)", async () => {
		expectRefusedNaming(await call("list_runs", { outcome: "not-judged" }), "outcome");
	});

	/*
	 * One row per nested input object, each otherwise valid so the unknown key
	 * is the only issue the schema finds. The open shapes (`auth`,
	 * `thresholds`, an OAuth 2.0 `config`, every map) are not here: the walk
	 * below holds them to a named list.
	 */
	const URL = "https://api.example.com/x";
	const SAVED = { collectionId: "c1", name: "r", url: URL };
	it.each([
		[
			"start_load_run",
			"scenario",
			{ scenario: { collectionId: "c1", iterations: 5 } },
			'scenario: Unrecognized key: "iterations"',
		],
		[
			"start_load_run",
			"monitor",
			{
				url: URL,
				monitor: { url: "http://127.0.0.1:9100/metrics", series: ["up"], [UNKNOWN]: 1 },
			},
			`monitor: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"start_load_run",
			"elements",
			{ url: URL, elements: { timers: "off", [UNKNOWN]: 1 } },
			`elements: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"run_collection",
			"elements",
			{ collectionId: "c1", elements: { timers: "off", [UNKNOWN]: 1 } },
			`elements: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"run_request",
			"a header line",
			{ url: URL, headers: [{ name: "X-A", value: "1", [UNKNOWN]: 1 }] },
			`headers.0: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"create_request",
			"a stored header row",
			{ ...SAVED, headers: [{ key: "X-A", value: "1", [UNKNOWN]: 1 }] },
			`headers.0: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"create_request",
			"an element",
			{ ...SAVED, elements: [{ kind: "assert.status", config: {}, [UNKNOWN]: 1 }] },
			`elements.0: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"create_request",
			"a binary body's file",
			{ ...SAVED, bodyType: "binary", file: { src: "/data/a.bin", [UNKNOWN]: 1 } },
			`file: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"update_environment",
			"a variable entry",
			{ environmentId: "e1", variables: { token: { value: "v", [UNKNOWN]: 1 } } },
			`variables.token: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"start_mock_issuer",
			"a client",
			{ clients: [{ clientId: "cid", [UNKNOWN]: 1 }] },
			`clients.0: Unrecognized key: "${UNKNOWN}"`,
		],
		[
			"start_webhook_inbox",
			"the canned response",
			{ response: { status: 200, [UNKNOWN]: 1 } },
			`response: Unrecognized key: "${UNKNOWN}"`,
		],
	])("%s refuses an undeclared key in %s", async (name, _where, args, refusal) => {
		expectRefusedNaming(await call(name, args), refusal);
	});

	/**
	 * The top-level arguments whose object is open on purpose, by name and why.
	 * Each is listed only while some tool still carries it open, so an entry
	 * outlives no reason.
	 */
	const OPEN_ARGUMENTS: Record<string, string> = {
		auth: "each mode's members are the engine's to know (`authBlock`'s passthrough)",
		thresholds: "a `custom.<name>.<stat>` budget is a key no schema can name (catchall)",
		config: "fetch_oauth2_token's OAuth 2.0 config, read by the engine (passthrough)",
	};

	/** Each object node under @p schema that declares properties and leaves others open. */
	function openObjects(schema: unknown, path: string[], out: string[][]): string[][] {
		if (!schema || typeof schema !== "object") return out;
		const node = schema as Record<string, unknown>;
		if (node.properties && node.additionalProperties !== false) out.push(path);
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			openObjects(child, [...path, key], out);
		}
		for (const key of ["items", "additionalProperties"]) openObjects(node[key], path, out);
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			for (const member of (node[key] as unknown[] | undefined) ?? []) {
				openObjects(member, path, out);
			}
		}
		return out;
	}

	it("lists every input schema closed, apart from the declared open arguments", async () => {
		const { client, server } = await connectClient({ safety: EVERY_TOOL });
		const { tools } = await client.listTools();
		await server.close();
		expect(tools.length).toBe(listed.length);

		const open = tools.flatMap((tool) =>
			openObjects(tool.inputSchema, [], []).map((path) => ({ tool: tool.name, path }))
		);
		const undeclared = open.filter(
			({ path }) => path.length !== 1 || !(path[0] in OPEN_ARGUMENTS)
		);
		expect(undeclared).toEqual([]);
		expect([...new Set(open.map(({ path }) => path[0]))].sort()).toEqual(
			Object.keys(OPEN_ARGUMENTS).sort()
		);
	});
});

/**
 * `run_collection_smoke` reports a tick per row to a client that asked for
 * progress (#2451). The ask is the request's `progressToken`, which the SDK
 * client adds when `callTool` is given `onprogress`; a call without it must
 * put nothing on the wire.
 */
describe("progress notifications", () => {
	const SMOKE_ROWS = ["a", "b", "c"].map((id) => ({
		id,
		name: `req ${id}`,
		method: "GET",
		url: `https://api.example.com/${id}`,
	}));

	function smokeClient() {
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue(SMOKE_ROWS),
			composeRequest: async ({ requestId }: { requestId: string }) => ({
				method: "GET",
				url: `https://api.example.com/${requestId}`,
			}),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
	}

	/** Every `notifications/progress` any in-memory transport sent while @p run ran. */
	async function progressSent(run: () => Promise<unknown>) {
		const send = vi.spyOn(InMemoryTransport.prototype, "send");
		try {
			await run();
			return send.mock.calls
				.map(
					([message]) => message as { method?: string; params?: Record<string, unknown> }
				)
				.filter((message) => message.method === "notifications/progress");
		} finally {
			send.mockRestore();
		}
	}

	it("delivers a tick per row to a call that sent a progressToken, before the result", async () => {
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"] },
			client: smokeClient(),
		});
		const heard: Array<{ progress: number; total?: number; message?: string }> = [];
		const sent = await progressSent(async () => {
			await client.callTool(
				{ name: "run_collection_smoke", arguments: { collectionId: "c1" } },
				{ onprogress: (p) => heard.push(p) }
			);
		});

		// Non-empty before the loop reads it: 0/3, then one per row.
		expect(heard).toHaveLength(SMOKE_ROWS.length + 1);
		expect(heard.map((p) => p.progress)).toEqual([0, 1, 2, 3]);
		expect(heard.every((p) => p.total === SMOKE_ROWS.length)).toBe(true);
		expect(heard.slice(1).map((p) => p.message)).toEqual(["1/3 ok", "2/3 ok", "3/3 ok"]);
		// One token for the whole call, and it is the one the client sent.
		expect(new Set(sent.map((n) => n.params?.progressToken)).size).toBe(1);
		await server.close();
	});

	it("sends no progress notification to a call that sent no progressToken", async () => {
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"] },
			client: smokeClient(),
		});
		let res: unknown;
		const sent = await progressSent(async () => {
			res = await client.callTool({
				name: "run_collection_smoke",
				arguments: { collectionId: "c1" },
			});
		});
		// The run happened, so the empty list is an absence and not a no-op call.
		expect(res).toMatchObject({ structuredContent: { total: SMOKE_ROWS.length, passed: 3 } });
		expect(sent).toEqual([]);
		await server.close();
	});
});

/**
 * A paged smoke result carries fields beyond the matrix, and the SDK client
 * refuses a result its advertised schema does not declare (#2451), so the
 * page is read through the real client rather than the registry's own parse.
 */
describe("run_collection_smoke paging", () => {
	function pagedClient() {
		const rows = [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, name: `req ${n}` }));
		return fakeClient({
			listRequests: vi.fn().mockResolvedValue(rows),
			composeRequest: async ({ requestId }: { requestId: string }) => ({
				method: "GET",
				url: `https://api.example.com/${requestId}`,
			}),
			executeRequest: vi.fn().mockResolvedValue({ status: 200, testResults: [] }),
		});
	}

	it("returns the page, its size and where the next one starts through the SDK's validation", async () => {
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"] },
			client: pagedClient(),
		});
		const res = await client.callTool({
			name: "run_collection_smoke",
			arguments: { collectionId: "c1", limit: 2, offset: 2 },
		});
		expect(res.isError).toBeFalsy();
		expect(res.structuredContent).toMatchObject({
			total: 2,
			requestTotal: 5,
			hasMore: true,
			next: { offset: 4 },
		});
		const rows = (res.structuredContent as { results: Array<{ name: string }> }).results;
		expect(rows.map((row) => row.name)).toEqual(["req 3", "req 4"]);
		await server.close();
	});

	it("refuses a limit above 100 before anything is sent", async () => {
		const engine = pagedClient();
		const { client, server } = await connectClient({
			safety: { allowlist: ["api.example.com"] },
			client: engine,
		});
		// Refused as a protocol error or as an error result, whichever the SDK picks.
		const refused = await client
			.callTool({
				name: "run_collection_smoke",
				arguments: { collectionId: "c1", limit: 101 },
			})
			.then(
				(res) => res.isError === true,
				() => true
			);
		expect(refused).toBe(true);
		expect(engine.executeRequest).not.toHaveBeenCalled();
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

	describe("with the engine unreachable (#3577)", () => {
		const down = () => new TypeError("fetch failed");

		it("lists the static resources and no run reports, and does not fail the list", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({
					listRuns: vi.fn().mockRejectedValue(down()),
				}),
			});
			const { resources } = await client.listResources();
			const uris = resources.map((r) => r.uri);
			expect(uris).toContain("vayu://runs");
			expect(uris).toContain("vayu://scripting/types");
			expect(uris.filter((uri) => uri.startsWith("vayu://run/"))).toEqual([]);
			await server.close();
		});

		it("still fails the list for an engine failure that is not an outage", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({
					listRuns: vi
						.fn()
						.mockRejectedValue(new EngineRequestError("GET /runs failed", 500, "boom")),
				}),
			});
			const err = await client.listResources().catch((e: Error) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toMatch(/Could not reach the Vayu engine/);
			await server.close();
		});

		it("still fails the list for a cancelled call, and words no read as an interrupted tool call", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({
					listRuns: vi.fn().mockRejectedValue(new Error("engine request aborted")),
					getScriptTypeDefinitions: vi
						.fn()
						.mockRejectedValue(new Error("engine request aborted")),
				}),
			});
			const list = await client.listResources().catch((e: Error) => e);
			expect(list).toBeInstanceOf(Error);
			const read = await client
				.readResource({ uri: "vayu://scripting/types" })
				.catch((e: Error) => e);
			expect((read as Error).message).not.toMatch(/may still have completed/);
			await server.close();
		});

		it("leads a read with the engine-unreachable sentence, not a bare fetch failure", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({
					getScriptTypeDefinitions: vi.fn().mockRejectedValue(down()),
				}),
			});
			const read = client.readResource({ uri: "vayu://scripting/types" });
			await expect(read).rejects.toThrow(
				/^.*Could not reach the Vayu engine\. The Vayu app is open/
			);
			await server.close();
		});

		it("leads a templated read and a prompt the same way", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({
					getRunReport: vi.fn().mockRejectedValue(down()),
				}),
			});
			await expect(client.readResource({ uri: "vayu://run/run_1/report" })).rejects.toThrow(
				/Could not reach the Vayu engine\./
			);
			await expect(
				client.getPrompt({ name: "summarize_run", arguments: { runId: "run_1" } })
			).rejects.toThrow(/Could not reach the Vayu engine\./);
			await server.close();
		});

		it("words a failed run-id completion the same way", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({ listRuns: vi.fn().mockRejectedValue(down()) }),
			});
			await expect(
				client.complete({
					ref: { type: "ref/resource", uri: RUN_REPORT_RESOURCE.uriTemplate },
					argument: { name: "runId", value: "run" },
				})
			).rejects.toThrow(/Could not reach the Vayu engine\./);
			await server.close();
		});

		it("does not wrap the outage-led masking failure a second time", async () => {
			const { client, server } = await connectClient({
				client: fakeClient({ getGlobals: vi.fn().mockRejectedValue(down()) }),
			});
			const err = await client.readResource({ uri: "vayu://runs" }).catch((e: Error) => e);
			const message = (err as Error).message;
			expect(message.match(/Could not reach the Vayu engine/g)).toHaveLength(1);
			expect(message).toMatch(/withheld whole/);
			await server.close();
		});
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

	// Mutation check: `z.object` for `argumentsSchema` in `registerPrompts`
	// leaves the key out of the answer (or builds the prompt) on every row.
	it.each(PROMPTS.map((prompt) => prompt.name))(
		"%s refuses an argument it does not declare, by name",
		async (name) => {
			const { client, server } = await connectClient();
			await expect(
				client.getPrompt({ name, arguments: { notAnArgument: "x" } })
			).rejects.toThrow('Unrecognized key: "notAnArgument"');
			await server.close();
		}
	);

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
	 * served here, the advertised URL, and a renderer default - with nothing
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
		expect(server.url).toBe(mcpEndpointUrl(MCP_PORT));
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
	let inFlight = new InFlightCalls();

	afterEach(async () => {
		await client?.close().catch(() => {});
		client = null;
		await httpServer?.stop();
		httpServer = null;
	});

	async function host(opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}) {
		const port = await freePort();
		inFlight = new InFlightCalls();
		httpServer = new McpHttpServer({
			host: HOST,
			port,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(opts.safety, opts.client),
			inFlightCalls: inFlight,
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

	/*
	 * Every POST reaches a fresh server, so a 2025-era client's cancel lands on
	 * one that never saw the call it names; the host holds the call's abort
	 * handle instead, under the session id it issued and the request id (#3574).
	 * The mutation check is the `inFlight.cancel` in `http.ts`: drop it and
	 * `hang.aborted` never settles in the cancelling tests below.
	 */
	describe("a 2025-era client's cancel", () => {
		/** Shake hands as a raw client and answer the session id the host issued. */
		async function openSession(port: number): Promise<string> {
			const init = await post(port, {
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "raw-client", version: "1.0.0" },
				},
			});
			const issued = init.headers.get("mcp-session-id");
			expect(issued).not.toBeNull();
			return issued!;
		}

		const healthCall = (id: string | number) => ({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: "get_engine_health", arguments: {} },
		});

		const cancelOf = (requestId: string | number) => ({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId, reason: "test" },
		});

		function hangingHealth() {
			const hang = hangingEngineCall();
			const engine = fakeClient({ health: (signal?: AbortSignal) => hang.call(signal) });
			return { hang, engine };
		}

		it("aborts the call an SDK client cancels", async () => {
			const { hang, engine } = hangingHealth();
			const c = await connect({ client: engine });
			expect(c.getProtocolEra()).toBe("legacy");
			const controller = new AbortController();
			const call = c.callTool(
				{ name: "get_engine_health", arguments: {} },
				{ signal: controller.signal }
			);
			void call.catch(() => {});
			await hang.started;
			expect(inFlight.size).toBe(1);
			controller.abort();
			await hang.aborted;
			expect(hang.handedSignal()?.aborted).toBe(true);
			await expect(call).rejects.toThrow();
			expect(inFlight.size).toBe(0);
		});

		it("aborts a raw call by session id and request id, and ends its stream without a result", async () => {
			const { hang, engine } = hangingHealth();
			const port = await host({ client: engine });
			const session = await openSession(port);
			// Not awaited: the host flushes the stream's headers with its first event.
			const call = post(port, healthCall(77), { "mcp-session-id": session });
			await hang.started;
			const cancel = await post(port, cancelOf(77), { "mcp-session-id": session });
			expect(cancel.status).toBe(202);
			await hang.aborted;
			const answered = await call;
			expect(answered.status).toBe(200);
			expect(await answered.text()).not.toMatch(/"result"/);
			expect(inFlight.size).toBe(0);
		});

		it("is matched only within the session that sent the call", async () => {
			const { hang, engine } = hangingHealth();
			const port = await host({ client: engine });
			const session = await openSession(port);
			const otherSession = await openSession(port);
			const call = post(port, healthCall(77), { "mcp-session-id": session });
			await hang.started;

			// Each cancel is answered only after the host has looked it up, so a
			// match would already have removed the entry by the time it returns.
			const strays: Array<Record<string, string>> = [{ "mcp-session-id": otherSession }, {}];
			for (const headers of strays) {
				expect((await post(port, cancelOf(77), headers)).status).toBe(202);
			}
			// A string id is a different request from the number the call used.
			await post(port, cancelOf("77"), { "mcp-session-id": session });
			expect(inFlight.size).toBe(1);
			expect(hang.handedSignal()?.aborted).toBe(false);

			// As the one-message batch the SDK also accepts.
			const batched = await post(port, [cancelOf(77)], { "mcp-session-id": session });
			expect(batched.status).toBe(202);
			await hang.aborted;
			await (await call).text();
			expect(inFlight.size).toBe(0);
		});

		it("forgets a call that completes", async () => {
			const c = await connect();
			await c.callTool({ name: "get_engine_health", arguments: {} });
			// The result reaches the client a moment before its stream ends.
			await vi.waitFor(() => expect(inFlight.size).toBe(0), {
				timeout: ASYNC_UTIL_TIMEOUT_MS,
			});
		});

		it("forgets a call whose client disconnects", async () => {
			const { hang, engine } = hangingHealth();
			const port = await host({ client: engine });
			const session = await openSession(port);
			const call = http.request({
				host: HOST,
				port,
				path: "/mcp",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"mcp-session-id": session,
				},
			});
			call.on("error", () => {});
			call.end(JSON.stringify(healthCall(5)));
			await hang.started;
			expect(inFlight.size).toBe(1);
			call.destroy();
			await hang.aborted;
			await vi.waitFor(() => expect(inFlight.size).toBe(0), {
				timeout: ASYNC_UTIL_TIMEOUT_MS,
			});
		});
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
	let inFlight = new InFlightCalls();

	afterEach(async () => {
		for (const c of clients.splice(0)) await c.close().catch(() => {});
		await httpServer?.stop();
		httpServer = null;
		await service?.stop();
		service = null;
	});

	async function host(opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}) {
		const port = await freePort();
		inFlight = new InFlightCalls();
		httpServer = new McpHttpServer({
			host: HOST,
			port,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(opts.safety, opts.client),
			inFlightCalls: inFlight,
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

	/*
	 * The SDK ends a 2026-07-28 call when its client cancels; the host's own
	 * registry is for the 2025-era leg and holds nothing of this one.
	 */
	it("cancels a 2026-07-28 call without the host's in-flight registry", async () => {
		const hang = hangingEngineCall();
		const port = await host({
			client: fakeClient({ health: (signal?: AbortSignal) => hang.call(signal) }),
		});
		const c = await connectTo(port, { modern: true });
		const controller = new AbortController();
		const call = c.callTool(
			{ name: "get_engine_health", arguments: {} },
			{ signal: controller.signal }
		);
		void call.catch(() => {});
		await hang.started;
		expect(inFlight.size).toBe(0);
		controller.abort();
		await hang.aborted;
		expect(inFlight.size).toBe(0);
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
 * MCP switched off or the app quitting, as `main.ts` does it: the lifecycle
 * stops the service, then the listener that holds the port (#3575).
 */
describe("stopping the MCP server through its lifecycle", () => {
	const HOST = "127.0.0.1";
	const clients: Client[] = [];
	let lifecycle: McpLifecycle<McpHttpServer> | null = null;
	let rebound: McpListener | null = null;
	const agents: http.Agent[] = [];
	const sockets: net.Socket[] = [];

	const INITIALIZE_BODY = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "raw", version: "1.0.0" },
		},
	});

	afterEach(async () => {
		for (const c of clients.splice(0)) await c.close().catch(() => {});
		for (const agent of agents.splice(0)) agent.destroy();
		for (const socket of sockets.splice(0)) socket.destroy();
		await lifecycle?.stop();
		lifecycle = null;
		await rebound?.stop();
		rebound = null;
		vi.restoreAllMocks();
	});

	/**
	 * Every server bound from here on keeps an idle connection open for longer
	 * than a test runs, so a stop that waited out a keep-alive connection
	 * (Node's default is 5 s) is a hang the bound below catches, not a delay
	 * under it.
	 */
	function keepIdleConnectionsOpen() {
		const create = http.createServer;
		return vi.spyOn(http, "createServer").mockImplementation(((
			...args: Parameters<typeof create>
		) => {
			const server = create(...args);
			server.keepAliveTimeout = 10 * TEST_TIMEOUT_MS;
			return server;
		}) as typeof create);
	}

	/** Bind the port through the lifecycle, with idle connections kept open. */
	async function serve(engine: EngineClient, safety?: Partial<McpSafetyConfig>): Promise<number> {
		const keptOpen = keepIdleConnectionsOpen();
		const port = await freePort();
		lifecycle = createMcpLifecycle({
			isEnabled: () => true,
			endpoint: () => ({ host: HOST, port }),
			makeListener: (endpoint, loadHandler) => new McpListener({ ...endpoint, loadHandler }),
			loadServiceFactory: async () => (endpoint) =>
				new McpHttpServer({
					...endpoint,
					info: { name: "vayu", version: "test" },
					contextProvider: contextProvider(safety, engine),
				}),
			log: () => {},
		});
		await lifecycle.start();
		// Else the server that holds the port closes idle connections after 5 s
		// on its own, and a lingering one is a delay the bound does not see.
		expect(keptOpen).toHaveBeenCalled();
		return port;
	}

	async function connectLegacy(port: number): Promise<Client> {
		const c = new Client({ name: "legacy-e2e", version: "1.0.0" });
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		clients.push(c);
		expect(c.getProtocolEra()).toBe("legacy");
		return c;
	}

	/** The port rebinds the moment the stop resolves. */
	async function expectPortFree(port: number) {
		rebound = new McpListener({
			host: HOST,
			port,
			loadHandler: () => Promise.reject(new Error("not served")),
		});
		await rebound.start();
		expect(rebound.isRunning()).toBe(true);
	}

	/** What @p settling settles to, or "still waiting" if it hangs. */
	function within<T>(settling: Promise<T>): Promise<T | "still waiting"> {
		// A healthy stop takes milliseconds; the bound only has to outlast a
		// runner that stalls the event loop, not an exchange that never ends.
		const waited = new Promise<"still waiting">((resolve) =>
			setTimeout(() => resolve("still waiting"), ASYNC_UTIL_TIMEOUT_MS)
		);
		return Promise.race([settling, waited]);
	}

	const stopping = () => lifecycle!.stop().then(() => "stopped");

	/*
	 * The mutation checks, in `http.ts`: drop the `res.destroy()` from
	 * `endStreams()` and the stream ends empty, leaving the client waiting for
	 * an answer; skip `holdUntilClosed` for the call and the stop waits on the
	 * engine call. Either loses its race.
	 */
	it("stops while a 2025-era call waits for its headers, failing the client's fetch", async () => {
		const hang = hangingEngineCall();
		const port = await serve(
			fakeClient({ health: (signal?: AbortSignal) => hang.call(signal) })
		);
		const c = await connectLegacy(port);
		const outcome = c.callTool({ name: "get_engine_health", arguments: {} }).then(
			() => "answered",
			(err: unknown) => err
		);
		await hang.started;

		expect(await within(stopping())).toBe("stopped");
		await hang.aborted;
		// Nothing was sent yet, so the client's own fetch fails; a JSON-RPC error
		// the server wrote would arrive as a ProtocolError.
		const err = await within(outcome);
		expect(err).not.toBeInstanceOf(ProtocolError);
		expect(err).toBeInstanceOf(TypeError);
		expect(err).toHaveProperty("message", "fetch failed");
		await expectPortFree(port);
	});

	/** A one-row smoke run whose request never settles until it is aborted. */
	function hangingSmoke(hang: ReturnType<typeof hangingEngineCall>): EngineClient {
		return fakeClient({
			listRequests: async () => [
				{ id: "a", name: "req a", method: "GET", url: "https://api.example.com/a" },
			],
			composeRequest: async () => ({ method: "GET", url: "https://api.example.com/a" }),
			executeRequest: (_payload: unknown, signal?: AbortSignal) => hang.call(signal),
		});
	}
	const SMOKE_SAFETY = { allowlist: ["api.example.com"] };

	/**
	 * Start a smoke call on @p c and return once its first progress event has
	 * reached the client, so the call's response stream is under way.
	 */
	async function streamingSmokeCall(c: Client): Promise<{ outcome: Promise<unknown> }> {
		let heardProgress!: () => void;
		const progressed = new Promise<void>((resolve) => (heardProgress = resolve));
		const outcome = c
			.callTool(
				{ name: "run_collection_smoke", arguments: { collectionId: "c1" } },
				{ onprogress: () => heardProgress() }
			)
			.then(
				() => "answered",
				(err: unknown) => err
			);
		await progressed;
		return { outcome };
	}

	/**
	 * A call cut once its stream was under way is answered with the error
	 * frame the host writes; one cut with no answer would hold it until the
	 * SDK client's own 60 s request timeout, which `within` reads as still
	 * waiting.
	 */
	async function expectCutWith(outcome: Promise<unknown>, cause: string) {
		const err = await within(outcome);
		expect(err).toBeInstanceOf(ProtocolError);
		expect(err).toMatchObject({
			code: CUT_ERROR_CODE,
			message: expect.stringContaining(cause),
		});
	}

	/*
	 * Once a progress event (or a keep-alive comment, every 15 s) is out, the
	 * client is reading a 200 stream, and the SDK client settles the call only
	 * on a JSON-RPC response for its id (#3598). The mutation check: drop the
	 * error frames `HeldExchange.relay` enqueues when the stream ends, and the
	 * call is still waiting.
	 */
	it("stops while a 2025-era call is streaming, its headers already sent", async () => {
		const hang = hangingEngineCall();
		const port = await serve(hangingSmoke(hang), SMOKE_SAFETY);
		const c = await connectLegacy(port);
		const { outcome } = await streamingSmokeCall(c);
		await hang.started;

		expect(await within(stopping())).toBe("stopped");
		await hang.aborted;
		await expectCutWith(outcome, SERVER_STOPPED);
		await expectPortFree(port);
	});

	/*
	 * The SDK client cancels by aborting its own call, which rejects at once;
	 * an agent that sends `notifications/cancelled` itself is still waiting on
	 * the stream, as is a client whose cancel the host matched for it. The
	 * mutation check is the stop test's.
	 */
	it("ends a cancelled 2025-era call whose stream is under way with an error", async () => {
		const hang = hangingEngineCall();
		const port = await serve(hangingSmoke(hang), SMOKE_SAFETY);
		const sent: Array<{ id?: string | number; method?: string }> = [];
		const recording: typeof fetch = (input, init) => {
			if (typeof init?.body === "string") sent.push(...[JSON.parse(init.body)].flat());
			return fetch(input, init);
		};
		const c = new Client({ name: "legacy-e2e", version: "1.0.0" });
		await c.connect(
			new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`), {
				fetch: recording,
			})
		);
		clients.push(c);
		expect(c.getProtocolEra()).toBe("legacy");
		const { outcome } = await streamingSmokeCall(c);
		await hang.started;
		const call = sent.find((message) => message.method === "tools/call");
		expect(call?.id).toBeDefined();

		await c.notification({
			method: "notifications/cancelled",
			params: { requestId: call!.id!, reason: "test" },
		});
		await hang.aborted;
		await expectCutWith(outcome, CALL_CANCELLED);
	});

	async function connectModern(port: number): Promise<Client> {
		const c = new Client(
			{ name: "modern-e2e", version: "1.0.0" },
			{ versionNegotiation: { mode: "auto" } }
		);
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		clients.push(c);
		expect(c.getProtocolEra()).toBe("modern");
		return c;
	}

	/*
	 * The 2026-07-28 leg answers a call cut before its first frame with a bare
	 * 499, which the client fails on at once, and the host adds nothing to it;
	 * after progress, the SDK ends the stream with no answer and the host
	 * writes the error. The mutation check of the second is the stop test's.
	 */
	it("stops while a 2026-07-28 call waits for its first frame, failing it with a 499", async () => {
		const hang = hangingEngineCall();
		const port = await serve(
			fakeClient({ health: (signal?: AbortSignal) => hang.call(signal) })
		);
		const c = await connectModern(port);
		const outcome = c.callTool({ name: "get_engine_health", arguments: {} }).then(
			() => "answered",
			(err: unknown) => err
		);
		await hang.started;

		expect(await within(stopping())).toBe("stopped");
		await hang.aborted;
		const err = await within(outcome);
		expect(err).not.toBeInstanceOf(ProtocolError);
		expect(err).toMatchObject({ data: { status: 499 } });
		await expectPortFree(port);
	});

	it("stops while a 2026-07-28 call is streaming, its progress already sent", async () => {
		const hang = hangingEngineCall();
		const port = await serve(hangingSmoke(hang), SMOKE_SAFETY);
		const c = await connectModern(port);
		const { outcome } = await streamingSmokeCall(c);
		await hang.started;

		expect(await within(stopping())).toBe("stopped");
		await hang.aborted;
		await expectCutWith(outcome, SERVER_STOPPED);
		await expectPortFree(port);
	});

	/*
	 * The cancel registry holds a call only under an issued session id, keyed
	 * and capped; a stop has to end the rest too. The mutation check: drop
	 * every call but the registry's from the sweep in `endStreams()` and the
	 * stop waits on the untracked ones.
	 */
	it("drops the 2025-era calls the cancel registry does not hold", async () => {
		const hangs = [hangingEngineCall(), hangingEngineCall(), hangingEngineCall()];
		let served = 0;
		const port = await serve(
			fakeClient({ health: (signal?: AbortSignal) => hangs[served++].call(signal) })
		);
		const call = (id: number, headers: Record<string, string>) =>
			fetch(`http://${HOST}:${port}/mcp`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...headers,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name: "get_engine_health", arguments: {} },
				}),
			}).then((res) => res.text());
		// No session id, which no cancel can name; and two calls under one key,
		// of which the registry holds only the later.
		const calls = [
			call(1, {}),
			call(9, { "mcp-session-id": "s1" }),
			call(9, { "mcp-session-id": "s1" }),
		];
		for (const sent of calls) void sent.catch(() => {});
		await Promise.all(hangs.map((hang) => hang.started));

		expect(await within(stopping())).toBe("stopped");
		await Promise.all(hangs.map((hang) => hang.aborted));
		await expectPortFree(port);
	});

	/*
	 * The mutation check: drop the connection end in `createMcpSocketServer`
	 * (`gates.ts`) and the stop waits on the answered request's idle
	 * connection, losing the race.
	 */
	it("still answers a request whose body is arriving when the stop is requested", async () => {
		const port = await serve(fakeClient());
		const body = INITIALIZE_BODY;
		const half = Math.floor(body.length / 2);
		// Node's global agent closes an idle socket itself after 5 s.
		const agent = new http.Agent({ keepAlive: true });
		agents.push(agent);
		let answered!: (answer: { status: number; text: string }) => void;
		const answer = new Promise<{ status: number; text: string }>((r) => (answered = r));
		const upload = http.request(
			{
				host: HOST,
				port,
				agent,
				path: "/mcp",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let text = "";
				res.on("data", (d) => (text += d));
				res.on("end", () => answered({ status: res.statusCode ?? 0, text }));
			}
		);
		upload.on("error", (err) => answered({ status: 0, text: String(err) }));
		upload.write(body.slice(0, half));
		// The request has reached the service, which is now reading its body.
		await vi.waitFor(() => expect(lifecycle!.service()).not.toBeNull(), {
			timeout: ASYNC_UTIL_TIMEOUT_MS,
		});

		const stopped = within(stopping());
		upload.end(body.slice(half));
		const { status, text } = await answer;
		expect(status).toBe(200);
		expect(text).toMatch(/"serverInfo"/);
		expect(await stopped).toBe("stopped");
	});

	/*
	 * A client that does not answer the server's FIN with its own: only the
	 * server closing the socket ends the connection. The mutation check: half-
	 * close it in `createMcpSocketServer` (`req.socket.end()`) for a request
	 * read in full too, and the stop waits on this connection.
	 */
	it("closes an answered connection whose client keeps its own side open", async () => {
		const port = await serve(fakeClient());
		const body = INITIALIZE_BODY;
		const half = Math.floor(body.length / 2);
		const socket = net.connect({ host: HOST, port, allowHalfOpen: true });
		sockets.push(socket);
		let received = "";
		socket.on("data", (chunk) => (received += chunk));
		socket.on("error", () => {});
		// The server's FIN, read after every byte before it.
		const ended = new Promise((resolve) => socket.once("end", resolve));
		socket.write(
			[
				"POST /mcp HTTP/1.1",
				`Host: ${HOST}:${port}`,
				"Content-Type: application/json",
				"Accept: application/json, text/event-stream",
				`Content-Length: ${Buffer.byteLength(body)}`,
				"",
				body.slice(0, half),
			].join("\r\n")
		);
		await vi.waitFor(() => expect(lifecycle!.service()).not.toBeNull(), {
			timeout: ASYNC_UTIL_TIMEOUT_MS,
		});

		const stopped = within(stopping());
		socket.write(body.slice(half));
		expect(await stopped).toBe("stopped");
		await ended;
		expect(received).toMatch(/^HTTP\/1\.1 200 /);
		expect(received).toMatch(/"serverInfo"/);
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
