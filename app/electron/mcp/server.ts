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
import { TOOLS, dispatchTool, type ElicitFn, type ToolContext } from "./tools.js";
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

/*
 * What belongs here: the cross-cutting facts no single tool description can
 * carry - the capability taxonomy, the safety model, and the other surfaces.
 *
 * What does not: tool names. The user can disable any tool individually, so a
 * roster written here is a list of things that may not exist in the session
 * reading it - which is why this text used to end by telling the reader to
 * trust `tools/list` over it. Each tool's own description is the one copy of
 * its contract, and it ships only when the tool does.
 */
const INSTRUCTIONS =
	"Vayu is a local API testing and load-testing platform (Postman-style requests " +
	"plus k6-level load tests in one app, backed by a native C++ engine); these " +
	"tools drive that engine. Start by checking engine health, so a later failure " +
	"is not mistaken for a bad request. Tools are grouped by capability, named in " +
	"each tool's own description: read (inspect collections, requests, " +
	"environments, runs, config and live metrics - always safe), execute (send " +
	"real traffic to a target), write (mutate saved data or engine config), and " +
	"load (start and stop load tests). " +
	"Every tool that puts traffic on the network is restricted to an allowlist, " +
	"and load runs additionally enforce hard RPS/concurrency/duration caps. Write " +
	"tools require the user to enable write access - until it is on they are not " +
	"listed at all, so a task that needs one is blocked on the user enabling it " +
	"rather than on finding the right call - and the destructive ones ask " +
	"for confirmation - via elicitation where the client supports it, otherwise by " +
	"returning what the call would destroy and waiting for a `confirmed: true` " +
	"retry. A tool that is subject to either gate says so in its own description. " +
	"`tools/list` is authoritative for what this session actually has. " +
	"Vayu data is also available as resources (vayu://runs, vayu://collections, " +
	"vayu://environments, vayu://config, and vayu://run/{runId}/report) to attach as " +
	"context, and prompts (summarize_run, compare_runs, diagnose_errors, " +
	"suggest_load_profile) provide ready-made starting points. Before writing a " +
	"preRequestScript or postRequestScript, read vayu://scripting/completions - it is " +
	"the engine's own list of every pm.* name the script sandbox provides, including " +
	"synchronous pm.crypto hashing and btoa/atob for signing a request.";

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

	// Bridge a tool's elicitation request to the client - but only if the client
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
		/*
		 * A write tool that cannot succeed does not ship its schema. Writes are
		 * off by default, and every write handler already refuses without
		 * `allowWrites`, so on a default install those 28 tools were ~40% of a
		 * `tools/list` an agent could do nothing with - paid for on every
		 * session, by every agent, to describe capabilities it does not have.
		 *
		 * Registration, not just refusal, because the cost is the schema rather
		 * than the call. The handler check stays: a client that cached a list
		 * from a session where writes were on still gets the actionable error
		 * rather than a silent failure.
		 */
		if (tool.category === "write" && !baseCtx.config.allowWrites) continue;
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
				// Through `dispatchTool`, not `tool.handler` directly: one dispatch
				// path means the disabled-tool rejection and the argument-error
				// translation cannot diverge between production and the tests.
				const result = await dispatchTool(
					tool.name,
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

	// Every callback below forwards `extra.signal` - the SDK aborts it when the
	// client cancels the request, and the engine client turns that into an
	// aborted fetch instead of a detached request running to its own timeout.
	for (const r of STATIC_RESOURCES) {
		mcp.registerResource(r.name, r.uri, meta(r.title, r.description), async (uri, extra) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify(await r.read(ctx, extra.signal), null, 2),
				},
			],
		}));
	}

	mcp.registerResource(
		RUN_REPORT_RESOURCE.name,
		new ResourceTemplate(RUN_REPORT_RESOURCE.uriTemplate, {
			list: async (extra) => {
				const runs = await RUN_REPORT_RESOURCE.listRuns(ctx, extra.signal);
				return {
					resources: extractRunIds(runs).map((id) => ({
						uri: `vayu://run/${id}/report`,
						name: `Run ${id} report`,
						mimeType: "application/json",
					})),
				};
			},
			complete: {
				// Unsignalled by necessity: the SDK's completion callback is
				// `(value, context?)` with no `RequestHandlerExtra`, so there is
				// no signal to forward here. Autocomplete is a single cheap
				// `/runs` read, so an uncancelled one costs little.
				runId: async (value: string) => {
					const runs = await RUN_REPORT_RESOURCE.listRuns(ctx);
					return extractRunIds(runs)
						.filter((id) => id.startsWith(value))
						.slice(0, 20);
				},
			},
		}),
		meta(RUN_REPORT_RESOURCE.title, RUN_REPORT_RESOURCE.description),
		async (uri, variables, extra) => {
			const raw = variables.runId;
			const runId = Array.isArray(raw) ? (raw[0] ?? "") : String(raw ?? "");
			const report = await RUN_REPORT_RESOURCE.read(ctx, runId, extra.signal);
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
			async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
				const result = await p.build(
					(args ?? {}) as Record<string, unknown>,
					ctx,
					extra?.signal
				);
				return result as typeof result & Record<string, unknown>;
			}
		);
	}
}
