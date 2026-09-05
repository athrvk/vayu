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
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	TOOLS,
	dispatchTool,
	withheldWriteRefusal,
	type ElicitFn,
	type ToolContext,
} from "./tools.js";
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
const INSTRUCTIONS_HEAD =
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
	"tools require write access, and the destructive ones ask " +
	"for confirmation - via elicitation where the client supports it, otherwise by " +
	"returning what the call would destroy and waiting for a `confirmed: true` " +
	"retry. A tool that is subject to either gate says so in its own description. ";

/**
 * The write gate, stated where an agent reads it before its first call - and
 * only in the sessions it applies to, since the server is rebuilt per request
 * and this text is therefore as current as `tools/list` itself.
 *
 * Withholding the write tools (#1429) took the handlers' "turn on write access"
 * refusal off the wire with them: the SDK rejects an unregistered name before
 * dispatch, so an agent on a default install saw no write tool and no reason
 * for its absence (#1431). It names the setting, and no tool.
 */
const WRITE_GATE_SENTENCE =
	"Write access is off in this session, so no write tool is listed: a task that " +
	"needs one is blocked on the user turning on Write access in Vayu Settings → " +
	"MCP, after which they appear in `tools/list`. ";

const INSTRUCTIONS_TAIL =
	"`tools/list` is authoritative for what this session actually has. " +
	"Vayu data is also available as resources (vayu://runs, vayu://collections, " +
	"vayu://environments, vayu://config, and vayu://run/{runId}/report) to attach as " +
	"context, and prompts (summarize_run, compare_runs, diagnose_errors, " +
	"suggest_load_profile) provide ready-made starting points. Before writing a " +
	"preRequestScript or postRequestScript, read vayu://scripting/completions - it is " +
	"the engine's own list of every pm.* name the script sandbox provides, including " +
	"synchronous pm.crypto hashing and btoa/atob for signing a request.";

/** The server instructions for one session, gated on that session's config. */
function instructionsFor(allowWrites: boolean): string {
	return INSTRUCTIONS_HEAD + (allowWrites ? "" : WRITE_GATE_SENTENCE) + INSTRUCTIONS_TAIL;
}

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
	const baseCtx = contextProvider();

	const mcp = new McpServer(
		{
			name: info.name,
			version: info.version,
			title: VAYU_TITLE,
			description: VAYU_DESCRIPTION,
			websiteUrl: VAYU_WEBSITE,
		},
		{
			capabilities: { tools: {} },
			instructions: instructionsFor(baseCtx.config.allowWrites),
		}
	);

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

	const sdkCallTool = captureCallToolHandler(mcp);

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

	answerWithheldWriteCalls(mcp, ctx, sdkCallTool());

	registerResources(mcp, ctx);
	registerPrompts(mcp, ctx);

	return mcp;
}

/**
 * A `tools/call` handler as the SDK's `Server` holds it.
 *
 * Deliberately loose in its request type: the wrapper below reads one field and
 * forwards the rest untouched, and restating the SDK's request shape here is a
 * second copy of it to drift.
 */
type CallToolHandler = (
	request: { params: { name: string } },
	extra: unknown
) => unknown | Promise<unknown>;

/**
 * Watch for the `tools/call` handler `registerTool` installs, and return a
 * getter for it.
 *
 * The SDK offers no pre-dispatch hook (1.30.0): its handler looks the name up in
 * its own registry and throws before anything of Vayu's runs, and it refuses to
 * be installed twice (`assertCanSetRequestHandler`), so a wrapper can only be
 * put in front of it by replacing it - which needs the original to delegate to.
 * `setRequestHandler` is public on both sides of this, and the interception is
 * removed again as soon as the registration loop is done.
 *
 * A capture that came back empty would leave the refusal unshipped exactly as
 * it is unshipped today, so what holds this to the SDK across an upgrade is the
 * protocol test that calls a withheld name and reads the answer.
 */
function captureCallToolHandler(mcp: McpServer): () => CallToolHandler | undefined {
	const server = mcp.server as unknown as {
		setRequestHandler: (schema: unknown, handler: CallToolHandler) => void;
	};
	const install = server.setRequestHandler.bind(server);
	let captured: CallToolHandler | undefined;

	server.setRequestHandler = (schema: unknown, handler: CallToolHandler) => {
		if (methodOf(schema) === "tools/call") captured = handler;
		install(schema, handler);
	};

	return () => {
		delete (server as Partial<typeof server>).setRequestHandler;
		return captured;
	};
}

/** The JSON-RPC method a request schema pins, or undefined for any other shape. */
function methodOf(schema: unknown): string | undefined {
	const method = (schema as { shape?: { method?: { value?: unknown } } })?.shape?.method?.value;
	return typeof method === "string" ? method : undefined;
}

/**
 * Answer a call to a write tool this session withheld with the refusal that
 * names the setting, in place of the SDK's "Tool <name> not found".
 *
 * The withholding (#1429) is what makes this necessary: it took the handlers'
 * refusal off the wire along with the schemas, leaving an agent that guessed a
 * write tool's name - from its own memory, or from a list it fetched while
 * writes were on - with an unknown-tool error and nothing to ask the user for
 * (#1431). Every other name reaches the SDK's handler unchanged, so schema
 * validation, structured output and task support are untouched.
 */
function answerWithheldWriteCalls(
	mcp: McpServer,
	ctx: ToolContext,
	sdkCallTool: CallToolHandler | undefined
): void {
	if (ctx.config.allowWrites || !sdkCallTool) return;
	const server = mcp.server as unknown as {
		setRequestHandler: (schema: unknown, handler: CallToolHandler) => void;
	};
	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		const refusal = withheldWriteRefusal(request.params.name, ctx);
		return refusal ?? sdkCallTool(request, extra);
	});
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
