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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";
import { McpHttpServer } from "./http.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

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
		listRuns: async () => [{ id: "run_1" }, { id: "run_2" }],
		listCollections: async () => [{ id: "col_1", name: "API" }],
		listEnvironments: async () => [],
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "running" }),
		...overrides,
	} as unknown as EngineClient;
}

function contextProvider(
	safety?: Partial<McpSafetyConfig>,
	client?: EngineClient
): () => ToolContext {
	return () => ({ client: client ?? fakeClient(), config: resolveSafetyConfig(safety) });
}

/** Connect a real SDK client to the Vayu server over a linked in-memory pair. */
async function connectClient(
	opts: {
		safety?: Partial<McpSafetyConfig>;
		client?: EngineClient;
		elicit?: (req: unknown) => { action: string; content?: Record<string, unknown> };
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
		client.setRequestHandler(ElicitRequestSchema, async (req) => handler(req));
	}
	// connect() performs the initialize handshake.
	await client.connect(clientTransport);
	return { client, server };
}

describe("MCP protocol handshake (in-memory)", () => {
	it("initializes and lists every tool by default", async () => {
		const { client, server } = await connectClient();
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("get_engine_health");
		expect(names).toContain("get_engine_config");
		expect(names).toContain("update_engine_config");
		expect(names).toContain("start_load_run");
		await server.close();
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
		// Unregistered → the SDK returns an error result ("tool not found").
		const res = (await client.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/not found/i);
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
		await server.close();
	});

	it("reads a static resource (vayu://runs)", async () => {
		const { client, server } = await connectClient();
		const res = await client.readResource({ uri: "vayu://runs" });
		expect(res.contents[0].mimeType).toBe("application/json");
		expect(String((res.contents[0] as { text?: string }).text)).toContain("run_1");
		await server.close();
	});

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
	// A fresh port per test avoids TIME_WAIT / socket-reuse races on rapid
	// start/stop of the same fixed port.
	let nextPort = 9878;
	let activePort = 0;
	let httpServer: McpHttpServer | null = null;

	afterEach(async () => {
		await httpServer?.stop();
		httpServer = null;
	});

	async function start(safety?: Partial<McpSafetyConfig>) {
		activePort = nextPort++;
		httpServer = new McpHttpServer({
			host: HOST,
			port: activePort,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(safety),
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
	}): Promise<{ status: number; json: unknown }> {
		return new Promise((resolve) => {
			const data = opts.body === undefined ? "" : JSON.stringify(opts.body);
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
						let json: unknown;
						try {
							json = JSON.parse(out);
						} catch {
							json = undefined;
						}
						resolve({ status: res.statusCode ?? 0, json });
					});
				}
			);
			req.on("error", () => resolve({ status: 0, json: undefined }));
			if (data) req.write(data);
			req.end();
		});
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

	it("rejects a forged Host header (DNS-rebinding protection)", async () => {
		await start();
		// Rejection may surface as a non-200 status or a dropped connection
		// (status 0); either way it must not succeed.
		const res = await request({ host: "evil.example.com", body: initBody });
		expect(res.status).not.toBe(200);
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
	let nextPort = 9895;
	let httpServer: McpHttpServer | null = null;
	let client: Client | null = null;

	afterEach(async () => {
		await client?.close().catch(() => {});
		client = null;
		await httpServer?.stop();
		httpServer = null;
	});

	async function connect(
		opts: { safety?: Partial<McpSafetyConfig>; client?: EngineClient } = {}
	) {
		const port = nextPort++;
		httpServer = new McpHttpServer({
			host: HOST,
			port,
			info: { name: "vayu", version: "test" },
			contextProvider: contextProvider(opts.safety, opts.client),
		});
		await httpServer.start();
		const c = new Client({ name: "http-e2e", version: "1.0.0" });
		await c.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${port}/mcp`)));
		client = c;
		return c;
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
});
