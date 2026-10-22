/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `get_safety_config` (issue #2444): the caps, the allowlist and the gate flags
 * an agent is asked to respect, readable in one call instead of one refusal at
 * a time. The values come from the session's config, so every case builds its
 * own and asserts the answer follows it.
 */

import { describe, expect, test } from "vitest";

import { resolveSafetyConfig, type McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import { safetyConfigSchema } from "./tools/output-schemas.js";
import type { McpHost } from "./tools/contract.js";
import { dispatchTool, TOOLS, type ToolContext } from "./tools.js";

function ctxWith(safety: Partial<McpSafetyConfig> = {}, host: McpHost = "app"): ToolContext {
	// No engine call: a client that throws on any use proves the read is local.
	const client = new Proxy(
		{},
		{
			get: (_target, method) => {
				throw new Error(`get_safety_config reached the engine (${String(method)})`);
			},
		}
	) as unknown as EngineClient;
	return { client, config: resolveSafetyConfig(safety), host };
}

async function read(safety: Partial<McpSafetyConfig> = {}, host: McpHost = "app") {
	const result = await dispatchTool("get_safety_config", {}, ctxWith(safety, host));
	expect(result.isError).toBeFalsy();
	return result;
}

const answer = async (safety: Partial<McpSafetyConfig> = {}, host: McpHost = "app") =>
	(await read(safety, host)).structuredContent;

describe("get_safety_config", () => {
	test("reports the caps and allowlist the session was configured with", async () => {
		// Mutation check: return DEFAULT_MCP_SAFETY_CONFIG's values and this fails.
		const reported = await answer({
			maxConcurrency: 50,
			maxRps: 120,
			maxDurationSeconds: 45,
			maxIterations: 900,
			allowlist: ["a.test"],
		});
		expect(reported).toMatchObject({
			allowlist: { allowAll: false, hosts: ["a.test"] },
			caps: { maxRps: 120, maxConcurrency: 50, maxDurationSeconds: 45, maxIterations: 900 },
		});
	});

	test("a default session reports the defaults: an empty allowlist and every gate off", async () => {
		expect(await answer()).toEqual({
			allowlist: { allowAll: false, hosts: [] },
			caps: {
				maxRps: 1000,
				maxConcurrency: 200,
				maxDurationSeconds: 300,
				maxIterations: 10000,
			},
			gates: {
				allowWrites: false,
				allowNetworkSettings: false,
				revealSecretsToAgents: false,
			},
			disabledToolCount: 0,
		});
	});

	test("allowAll reports true", async () => {
		expect(await answer({ allowAll: true })).toMatchObject({
			allowlist: { allowAll: true },
		});
	});

	test("each gate flag follows its own setting", async () => {
		const on = await answer({
			allowWrites: true,
			allowNetworkSettings: true,
			revealSecretsToAgents: true,
		});
		expect(on).toMatchObject({
			gates: { allowWrites: true, allowNetworkSettings: true, revealSecretsToAgents: true },
		});
		const onlyReveal = await answer({ revealSecretsToAgents: true });
		expect(onlyReveal).toMatchObject({
			gates: { allowWrites: false, allowNetworkSettings: false, revealSecretsToAgents: true },
		});
	});

	test("a CLI session answers the same shape from its own config", async () => {
		const reported = await answer({ maxRps: 7, allowlist: ["cli.test"] }, "cli");
		expect(reported).toMatchObject({
			allowlist: { hosts: ["cli.test"] },
			caps: { maxRps: 7 },
		});
	});

	test("the answer satisfies the declared outputSchema", async () => {
		const tool = TOOLS.find((t) => t.name === "get_safety_config");
		expect(tool?.outputSchema).toBe(safetyConfigSchema);
		const parsed = safetyConfigSchema.safeParse(await answer({ allowlist: ["a.test"] }));
		expect(parsed.success).toBe(true);
	});

	test("gates are on/off booleans and no tool name rides in the answer", async () => {
		const result = await read({
			revealSecretsToAgents: true,
			allowlist: ["a.test"],
			disabledTools: ["run_request", "delete_collection"],
		});
		expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual([
			"allowlist",
			"caps",
			"disabledToolCount",
			"gates",
		]);
		const gates = (result.structuredContent as { gates: Record<string, unknown> }).gates;
		expect(Object.keys(gates).sort()).toEqual([
			"allowNetworkSettings",
			"allowWrites",
			"revealSecretsToAgents",
		]);
		for (const value of Object.values(gates)) expect(typeof value).toBe("boolean");

		// Disabled tools are a count: the names stay out of the text and the structure.
		expect(result.structuredContent).toMatchObject({ disabledToolCount: 2 });
		const text = JSON.stringify([result.content, result.structuredContent]);
		for (const tool of TOOLS) expect(text, tool.name).not.toContain(tool.name);
	});

	test("is a read: no engine call, no confirmation, no data-changed event", () => {
		const tool = TOOLS.find((t) => t.name === "get_safety_config");
		expect(tool).toMatchObject({ category: "read", invalidates: [] });
		expect(tool?.annotations.readOnlyHint).toBe(true);
	});
});
