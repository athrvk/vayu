/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file server-host.test.ts
 * @brief What a session tells its user to do about a refusal depends on the
 *        host serving it (#2439): the app has Settings screens and a window, the
 *        stdio CLI has `VAYU_MCP_*` variables and a `vayu-engine` process. Every
 *        guard, outage and gate sentence is driven through the real tool
 *        dispatch and the real server for both hosts, so a message that names
 *        the other host's remedy fails here and not in a user's Zed session.
 */

import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { dispatchTool, type ToolContext } from "./tools.js";
import type { McpHost } from "./tools/contract.js";
import type { EngineClient } from "./engine-client.js";

/** What names the other host's remedy: never allowed to reach a CLI session. */
const APP_ONLY_WORDING = /Settings|Vayu app/;

function fakeClient(overrides: Partial<Record<keyof EngineClient, unknown>> = {}): EngineClient {
	return {
		// Identity composition, as the engine's POST /compose answers an inline request.
		composeRequest: async (body: { request?: object }) => ({ ...(body.request ?? {}) }),
		getConfig: async () => ({ entries: [{ key: "dbCacheSize", requiresRestart: true }] }),
		updateConfig: async () => ({ entries: [] }),
		getGlobals: async () => ({ variables: {} }),
		listEnvironments: async () => [],
		listCollections: async () => [],
		listAllRequests: async () => [],
		startRun: vi.fn().mockResolvedValue({ runId: "run_1", status: "running" }),
		...overrides,
	} as unknown as EngineClient;
}

function ctxFor(
	host: McpHost,
	safety: Partial<McpSafetyConfig> = {},
	client: EngineClient = fakeClient()
): ToolContext {
	return { client, config: resolveSafetyConfig(safety), host };
}

/** The text of a tool call that is expected to be refused. */
async function refusal(
	host: McpHost,
	tool: string,
	args: Record<string, unknown>,
	safety: Partial<McpSafetyConfig> = {},
	client?: EngineClient
): Promise<string> {
	const res = await dispatchTool(tool, args, ctxFor(host, safety, client));
	expect(res.isError, `${tool} should have been refused`).toBe(true);
	return res.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

const ALLOWED = { allowlist: ["api.example.com"] };
const SEND = { url: "https://api.example.com/x", confirmed: true };

interface Guard {
	name: string;
	/** What the CLI must name, the exact variable or process. */
	cliNames: readonly string[];
	/** What the app must name. */
	appNames: readonly string[];
	trigger: (host: McpHost) => Promise<string>;
}

const SETTINGS_PATH = "Vayu Settings → MCP";

const GUARDS: readonly Guard[] = [
	{
		name: "empty allowlist",
		cliNames: ["VAYU_MCP_ALLOWLIST"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "run_request", { url: "https://api.example.com/x" }),
	},
	{
		name: "host not on the allowlist",
		cliNames: ["VAYU_MCP_ALLOWLIST"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "run_request", { url: "https://evil.test/x" }, ALLOWED),
	},
	{
		name: "monitor host not on the allowlist",
		cliNames: ["VAYU_MCP_ALLOWLIST"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"start_load_run",
				{ ...SEND, monitor: { url: "https://metrics.evil.test/m", series: ["up"] } },
				ALLOWED
			),
	},
	{
		name: "targetRps cap",
		cliNames: ["VAYU_MCP_MAX_RPS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "start_load_run", { ...SEND, targetRps: 50_000 }, ALLOWED),
	},
	{
		name: "concurrency cap",
		cliNames: ["VAYU_MCP_MAX_CONCURRENCY"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"start_load_run",
				{ ...SEND, mode: "constant_concurrency", concurrency: 9_000 },
				ALLOWED
			),
	},
	{
		name: "duration cap",
		cliNames: ["VAYU_MCP_MAX_DURATION_SECONDS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "start_load_run", { ...SEND, duration: "24h" }, ALLOWED),
	},
	{
		name: "iterations cap",
		cliNames: ["VAYU_MCP_MAX_ITERATIONS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"start_load_run",
				{ ...SEND, mode: "iterations", iterations: 1_000_000_000 },
				ALLOWED
			),
	},
	{
		name: "writes disabled",
		cliNames: ["VAYU_MCP_ALLOW_WRITES"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "create_collection", { name: "API" }),
	},
	{
		name: "engine config writes disabled",
		cliNames: ["VAYU_MCP_ALLOW_WRITES"],
		appNames: [SETTINGS_PATH],
		trigger: (host) => refusal(host, "update_engine_config", { entries: { workers: "4" } }),
	},
	{
		name: "network settings closed",
		cliNames: ["VAYU_MCP_ALLOW_NETWORK_SETTINGS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"update_engine_config",
				{ entries: { proxyUrl: "http://proxy.test:8080" } },
				{ allowWrites: true }
			),
	},
	{
		name: "script refused while reveal is off",
		cliNames: ["VAYU_MCP_REVEAL_SECRETS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"run_request",
				{ url: "https://api.example.com/x", preRequestScript: "pm.variables.set('a', 1);" },
				ALLOWED
			),
	},
	{
		name: "secret flag cleared while reveal is off",
		cliNames: ["VAYU_MCP_REVEAL_SECRETS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(
				host,
				"update_globals",
				{ variables: { token: { secret: false } } },
				{ allowWrites: true },
				fakeClient({
					getGlobals: async () => ({
						variables: { token: { value: "t", secret: true, enabled: true } },
					}),
				})
			),
	},
	{
		name: "tool switched off",
		cliNames: ["VAYU_MCP_DISABLED_TOOLS"],
		appNames: [SETTINGS_PATH],
		trigger: (host) =>
			refusal(host, "get_engine_health", {}, { disabledTools: ["get_engine_health"] }),
	},
	{
		name: "engine unreachable",
		cliNames: ["vayu-engine", "VAYU_ENGINE_URL"],
		appNames: ["Vayu app"],
		trigger: (host) =>
			refusal(
				host,
				"run_request",
				{ url: "https://api.example.com/x" },
				ALLOWED,
				fakeClient({
					executeRequest: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
				})
			),
	},
];

describe("guard and outage messages, per host", () => {
	it("scans a non-empty list of guards", () => {
		expect(GUARDS.length).toBeGreaterThanOrEqual(14);
	});

	describe.each(GUARDS)("$name", (guard) => {
		it("names the variable or process to the CLI and never the app", async () => {
			const text = await guard.trigger("cli");
			expect(text).not.toBe("");
			expect(text).not.toMatch(APP_ONLY_WORDING);
			for (const name of guard.cliNames) expect(text).toContain(name);
		});

		it("names the Settings path to the app", async () => {
			const text = await guard.trigger("app");
			for (const name of guard.appNames) expect(text).toContain(name);
		});
	});

	it("names how each host restarts the engine for a restart-required key", async () => {
		const run = (host: McpHost) =>
			dispatchTool(
				"update_engine_config",
				{ entries: { dbCacheSize: "67108864" } },
				ctxFor(
					host,
					{ allowWrites: true },
					fakeClient({
						getConfig: async () => ({
							entries: [
								{ key: "dbCacheSize", value: "67108864", requiresRestart: true },
							],
						}),
					})
				)
			);
		const cli = (await run("cli")).content[0] as { text: string };
		expect(cli.text).toContain("restart vayu-engine");
		expect(cli.text).not.toMatch(APP_ONLY_WORDING);
		const app = (await run("app")).content[0] as { text: string };
		expect(app.text).toContain("Vayu Settings → restart engine");
	});
});

describe("server instructions, per host", () => {
	async function instructionsFor(host: McpHost, safety: Partial<McpSafetyConfig>) {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createMcpServer({ name: "vayu", version: "test" }, () =>
			ctxFor(host, safety)
		);
		await server.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const text = client.getInstructions() ?? "";
		await server.close();
		return text;
	}

	it("sends a CLI session to the variables, with writes and reveal both off", async () => {
		const text = await instructionsFor("cli", {});
		// Both gate sentences must be present or the scan below proves nothing.
		expect(text).toMatch(/write access is off in this session/i);
		expect(text).toMatch(/secret values are withheld in this session/i);
		expect(text).toContain("VAYU_MCP_ALLOW_WRITES");
		expect(text).toContain("VAYU_MCP_REVEAL_SECRETS");
		expect(text).not.toMatch(APP_ONLY_WORDING);
	});

	it("keeps the Settings path for an app session", async () => {
		const text = await instructionsFor("app", {});
		expect(text).toContain("turn on Write access in Vayu Settings → MCP");
		expect(text).toContain("turn on Reveal secrets to agents in Vayu Settings → MCP");
		expect(text).not.toContain("VAYU_MCP_");
	});
});
