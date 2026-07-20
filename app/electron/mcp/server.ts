/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file server.ts
 * @brief Builds a configured MCP server (official SDK high-level `McpServer`)
 *        with the Vayu tool registry. Each enabled tool is registered with its
 *        Zod input schema (validated automatically), annotations, and optional
 *        output schema. A per-instance context (engine client + current safety
 *        config + an elicitation bridge) is closed over each tool. Transport-
 *        agnostic: connected to Streamable HTTP (Electron) or stdio (CLI).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, type ElicitFn, type ToolContext } from "./tools.js";
import { STATIC_RESOURCES, RUN_REPORT_RESOURCE, extractRunIds } from "./resources.js";
import { PROMPTS } from "./prompts.js";

/** Provides the per-request tool context (client + current safety config). */
export type ToolContextProvider = () => ToolContext;

export interface McpServerInfo {
	name: string;
	version: string;
}

/** Vayu's identity, surfaced to clients via the server's Implementation info. */
const VAYU_TITLE = "Vayu";
const VAYU_DESCRIPTION =
	"Vayu is a local API testing and load-testing platform: Postman-style requests " +
	"plus k6-level load tests in one app, driven by a native C++ engine. This MCP " +
	"server exposes that engine so an agent can send requests, run and analyze load " +
	"tests, and read or tune engine configuration on the user's machine.";
const VAYU_WEBSITE = "https://github.com/athrvk/vayu";

const INSTRUCTIONS =
	"Vayu is a local API testing and load-testing platform (Postman-style requests " +
	"plus k6-level load tests in one app, backed by a native C++ engine); these " +
	"tools drive that engine. Call get_engine_health first. Tools are grouped as " +
	"read (inspect collections, runs, config, metrics), write (run_request, " +
	"update_engine_config), and load (start_load_run, stop_run, get_live_metrics, " +
	"compare_runs). Network-touching tools (run_request, start_load_run) are " +
	"restricted to an allowlist and hard rate/duration caps. start_load_run asks " +
	"the user to confirm (via elicitation when supported, otherwise a confirmed:true " +
	"flag). update_engine_config requires the user to enable config writes. The user " +
	"may disable individual tools, so treat tools/list as authoritative and expect " +
	"some tools to be absent. Vayu data is also available as resources (vayu://runs, " +
	"vayu://collections, vayu://environments, vayu://config, and " +
	"vayu://run/{runId}/report) to attach as context, and prompts (summarize_run, " +
	"compare_runs, diagnose_errors, suggest_load_profile) provide ready-made starting points.";

/**
 * Create an MCP server exposing the Vayu tools. `contextProvider` is invoked
 * once per built server so the safety config can change at runtime (the HTTP
 * host builds a fresh server per request; the stdio CLI builds one per process).
 * Disabled tools are not registered, so they are absent from `tools/list`.
 */
export function createMcpServer(
	info: McpServerInfo,
	contextProvider: ToolContextProvider
): McpServer {
	const mcp = new McpServer(
		{
			name: info.name,
			version: info.version,
			title: VAYU_TITLE,
			description: VAYU_DESCRIPTION,
			websiteUrl: VAYU_WEBSITE,
		},
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS }
	);

	const baseCtx = contextProvider();

	// Bridge a tool's elicitation request to the client — but only if the client
	// negotiated the elicitation capability; otherwise throw so the tool falls
	// back to its flag-based gate rather than hanging.
	const elicit: ElicitFn = async (params) => {
		const caps = mcp.server.getClientCapabilities();
		if (!caps?.elicitation) throw new Error("client does not support elicitation");
		const res = await mcp.server.elicitInput(
			params as Parameters<typeof mcp.server.elicitInput>[0]
		);
		return { action: res.action, content: res.content };
	};

	const ctx: ToolContext = { ...baseCtx, elicit };

	for (const tool of TOOLS) {
		if (baseCtx.config.disabledTools.includes(tool.name)) continue;
		mcp.registerTool(
			tool.name,
			{
				title: tool.annotations.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
				annotations: tool.annotations,
			},
			async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
				const result = await tool.handler(
					(args ?? {}) as Record<string, unknown>,
					ctx,
					extra?.signal
				);
				return result as {
					content: Array<{ type: "text"; text: string }>;
					structuredContent?: Record<string, unknown>;
					isError?: boolean;
				};
			}
		);
	}

	registerResources(mcp, ctx);
	registerPrompts(mcp, ctx);

	return mcp;
}

/** Register the read-only Vayu data resources (static lists + run-report template). */
function registerResources(mcp: McpServer, ctx: ToolContext): void {
	const meta = (title: string, description: string) => ({
		title,
		description,
		mimeType: "application/json",
	});

	for (const r of STATIC_RESOURCES) {
		mcp.registerResource(r.name, r.uri, meta(r.title, r.description), async (uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(await r.read(ctx), null, 2),
				},
			],
		}));
	}

	mcp.registerResource(
		RUN_REPORT_RESOURCE.name,
		new ResourceTemplate(RUN_REPORT_RESOURCE.uriTemplate, {
			list: async () => {
				const runs = await RUN_REPORT_RESOURCE.listRuns(ctx);
				return {
					resources: extractRunIds(runs).map((id) => ({
						uri: `vayu://run/${id}/report`,
						name: `Run ${id} report`,
						mimeType: "application/json",
					})),
				};
			},
			complete: {
				runId: async (value: string) => {
					const runs = await RUN_REPORT_RESOURCE.listRuns(ctx);
					return extractRunIds(runs)
						.filter((id) => id.startsWith(value))
						.slice(0, 20);
				},
			},
		}),
		meta(RUN_REPORT_RESOURCE.title, RUN_REPORT_RESOURCE.description),
		async (uri, variables) => {
			const raw = variables.runId;
			const runId = Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? "");
			const report = await RUN_REPORT_RESOURCE.read(ctx, runId);
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify(report, null, 2),
					},
				],
			};
		}
	);
}

/** Register the server-provided prompt templates (summarize / compare / diagnose / plan). */
function registerPrompts(mcp: McpServer, ctx: ToolContext): void {
	for (const p of PROMPTS) {
		mcp.registerPrompt(
			p.name,
			{ title: p.title, description: p.description, argsSchema: p.argsSchema },
			async (args: Record<string, unknown>) => {
				const result = await p.build((args ?? {}) as Record<string, unknown>, ctx);
				return result as typeof result & Record<string, unknown>;
			}
		);
	}
}
