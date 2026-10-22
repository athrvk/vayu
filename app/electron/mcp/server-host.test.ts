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
import {
	TOOLS,
	dispatchTool,
	resolveDescription,
	toolCatalog,
	type McpTool,
	type ToolContext,
} from "./tools.js";
import type { McpHost } from "./tools/contract.js";
import { GUARDED_WRITE_SENTENCE, resolveRemedyTokens } from "./remedy.js";
import type { EngineClient } from "./engine-client.js";

/**
 * What names the other host's remedy: never allowed to reach a CLI session.
 * `Settings` is a word here, so the `allowNetworkSettings` flag a tool reports
 * is not mistaken for the app's Settings screen.
 */
const APP_ONLY_WORDING = /\bSettings\b|Vayu app/;

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
		name: "per-call TLS downgrade",
		cliNames: ["customCaCertificates", "VAYU_MCP_ALLOW_NETWORK_SETTINGS"],
		appNames: ["Vayu Settings > Network & connectivity"],
		trigger: (host) =>
			refusal(
				host,
				"run_request",
				{ url: "https://api.example.com/x", verifySSL: false },
				ALLOWED
			),
	},
	{
		name: "inline file body",
		cliNames: ["no setting that allows a folder"],
		appNames: ["Settings > Files"],
		trigger: (host) =>
			refusal(
				host,
				"run_request",
				{ url: "https://api.example.com/x", file: { src: "/a" } },
				ALLOWED
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
		expect(GUARDS.length).toBeGreaterThanOrEqual(16);
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

	/*
	 * A tool's description carries one pointer line (#2441), so the instructions
	 * are the one place each rule a tool used to state in full still lives. One
	 * fact per rule the removed sentences carried.
	 */
	it("states every withholding rule while reveal is off, and none while it is on", async () => {
		const off = await instructionsFor("app", {});
		for (const fact of [
			"`Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`",
			"`X-CSRF-Token` or the header the request's API-key auth names",
			"Postman import's `postman` source `valueWithheld: true`",
			"empty value or a pure {{variable}} reference is shown as written",
			"refused as `auth` by every tool that takes one",
			"(`?api_key=&page=2`)",
			"`params` row naming one reads `valueWithheld: true`",
			"a smoke test row's, composed or else stored",
			"`endpoint`, though never the schema",
			"`credentialsWithheld: true` on the config entry or the connection diagnosis's `proxy`",
			"reads `currentWithheld: true` in place of `current`",
			"a url cut short before its host ends",
			"inbox captures, mock activity) reads `<redacted>`",
			"4 bytes or longer, raw, percent-encoded, JSON- or XML-escaped",
			"`headerLines` / `requestHeaderLines` and `rawRequest` header lines, request and response alike",
			"an OAuth 2.0 token or an API key, whatever its source",
			"credential-named query value (matched on the whole name",
			"matched as UTF-8 and as Latin-1",
			"the request was sent with the real values",
			"answers an error naming it and none of the result",
			"confirmation preview shows the run as it will be recorded",
		]) {
			expect(off).toContain(fact);
		}
		const on = await instructionsFor("app", { revealSecretsToAgents: true });
		expect(on).not.toMatch(/Withheld|<redacted>/);
	});
});

/** Every string under @p value with the path that reaches it. */
function stringsOf(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
	if (typeof value === "string") out.push([path, value]);
	else if (Array.isArray(value))
		value.forEach((item, i) => stringsOf(item, `${path}[${i}]`, out));
	else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) stringsOf(item, `${path}.${key}`, out);
	}
	return out;
}

/** Everything a client can list in a session: tools (schemas included), resources and prompts. */
async function listEverything(host: McpHost, safety: Partial<McpSafetyConfig>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer({ name: "vayu", version: "test" }, () =>
		ctxFor(host, safety, fakeClient({ listRuns: async () => [] }))
	);
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	const [tools, resources, prompts] = await Promise.all([
		client.listTools(),
		client.listResources(),
		client.listPrompts(),
	]);
	await server.close();
	return { tools: tools.tools, resources: resources.resources, prompts: prompts.prompts };
}

/** The paths of every listed string that matches @p pattern, so a failure names the tool. */
function offenders(listing: Awaited<ReturnType<typeof listEverything>>, pattern: RegExp): string[] {
	const named: [string, unknown][] = [
		...listing.tools.map((t): [string, unknown] => [`tool ${t.name}`, t]),
		...listing.resources.map((r): [string, unknown] => [`resource ${r.name}`, r]),
		...listing.prompts.map((p): [string, unknown] => [`prompt ${p.name}`, p]),
	];
	return named.flatMap(([name, item]) =>
		stringsOf(item, name)
			.filter(([, text]) => pattern.test(text))
			.map(([path]) => path)
	);
}

/** @p tool's description in a session under the defaults (writes and reveal off). */
const defaultDescription = (tool: McpTool) => resolveDescription(tool, resolveSafetyConfig());

/** The write-gate descriptions the registry declares, so the scan cannot shrink unnoticed. */
const GUARDED_TOOL_COUNT = TOOLS.filter((t) => defaultDescription(t).includes("GUARDED")).length;

describe("tools/list, resources and prompts, per host", () => {
	it("registers at least the 31 GUARDED descriptions", () => {
		expect(GUARDED_TOOL_COUNT).toBeGreaterThanOrEqual(31);
	});

	describe.each([true, false])("CLI session, writes %s", (allowWrites) => {
		it("never names Settings or the Vayu app, and leaves no token unresolved", async () => {
			const listing = await listEverything("cli", { allowWrites });
			expect(listing.tools.length).toBeGreaterThan(0);
			expect(listing.resources.length).toBeGreaterThan(0);
			expect(listing.prompts.length).toBeGreaterThan(0);
			const guarded = listing.tools.filter((t) => t.description?.includes("GUARDED"));
			// With writes off the write tools are not listed, so only the gates
			// that are not the write gate remain.
			expect(guarded.length).toBeGreaterThan(0);
			if (allowWrites) expect(guarded.length).toBe(GUARDED_TOOL_COUNT);
			else expect(guarded.length).toBeLessThan(GUARDED_TOOL_COUNT);
			expect(offenders(listing, APP_ONLY_WORDING)).toEqual([]);
			expect(offenders(listing, /\{\{remedy:/)).toEqual([]);
		});

		it("names the variable that lifts each gate it describes", async () => {
			const { tools } = await listEverything("cli", { allowWrites });
			const description = (name: string) => tools.find((t) => t.name === name)?.description;
			expect(description("run_request")).toContain("VAYU_MCP_REVEAL_SECRETS=true");
			if (!allowWrites) return;
			expect(description("create_collection")).toContain("VAYU_MCP_ALLOW_WRITES=true");
			expect(description("update_engine_config")).toContain(
				"VAYU_MCP_ALLOW_NETWORK_SETTINGS=true"
			);
			expect(description("update_engine_config")).toContain("restart vayu-engine");
			const fileBody = tools.find((t) => t.name === "create_request")?.inputSchema.properties;
			expect(JSON.stringify(fileBody)).toContain("no setting that allows a folder");
		});
	});

	it("keeps the Settings sentence in an app session", async () => {
		const listing = await listEverything("app", { allowWrites: true });
		const guarded = listing.tools.filter((t) => t.description?.includes("GUARDED"));
		expect(guarded.length).toBe(GUARDED_TOOL_COUNT);
		const gate = resolveRemedyTokens(GUARDED_WRITE_SENTENCE, "app");
		expect(gate).toContain("Vayu Settings → MCP");
		const writeGated = guarded.filter((t) => t.description?.includes(gate));
		expect(writeGated.length).toBe(
			TOOLS.filter((t) => defaultDescription(t).includes(GUARDED_WRITE_SENTENCE)).length
		);
		expect(writeGated.length).toBeGreaterThanOrEqual(28);
		expect(offenders(listing, /\{\{remedy:/)).toEqual([]);
		const get = (name: string) => listing.tools.find((t) => t.name === name)?.description;
		expect(get("run_request")).toContain(
			"turn on Reveal secrets to agents in Vayu Settings → MCP"
		);
		expect(get("update_engine_config")).toContain("Vayu Settings → restart engine");
		expect(listing.resources.map((r) => r.description).join("\n")).toContain(
			"Vayu Settings → MCP"
		);
		expect(JSON.stringify(listing.tools)).not.toContain("VAYU_MCP_");
	});

	it("shows the Settings app wording in the app's own tool catalog", () => {
		const catalog = toolCatalog();
		expect(catalog.length).toBeGreaterThan(0);
		for (const entry of catalog) expect(entry.description).not.toMatch(/\{\{remedy:/);
		expect(catalog.find((t) => t.name === "create_collection")?.description).toContain(
			"turn on Write access in Vayu Settings → MCP"
		);
	});
});
