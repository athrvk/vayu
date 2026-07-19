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
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";
import { McpHttpServer } from "./http.js";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

function fakeClient(): EngineClient {
	return {
		health: async () => ({ status: "ok", version: "9.9.9" }),
		getConfig: async () => ({ entries: [{ key: "workers", value: "8" }] }),
	} as unknown as EngineClient;
}

function contextProvider(safety?: Partial<McpSafetyConfig>): () => ToolContext {
	return () => ({ client: fakeClient(), config: resolveSafetyConfig(safety) });
}

/** Connect a real SDK client to the Vayu server over a linked in-memory pair. */
async function connectClient(safety?: Partial<McpSafetyConfig>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({ name: "vayu", version: "test" }, contextProvider(safety));
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
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

	it("omits a disabled tool from tools/list and rejects calling it", async () => {
		const { client, server } = await connectClient({ disabledTools: ["get_engine_health"] });
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).not.toContain("get_engine_health");
		// Still listed tools work; the disabled one errors if called anyway.
		const res = (await client.callTool({ name: "get_engine_health", arguments: {} })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/disabled/i);
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
