/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools.ts
 * @brief The MCP tool registry. Each tool maps to engine capabilities, applies
 *        the safety guards (allowlist / caps / confirmation), and returns a
 *        text result. Transport-agnostic — the same registry backs both the
 *        Streamable HTTP server (Electron) and the stdio CLI.
 */

import type { EngineClient } from "./engine-client.js";
import { EngineRequestError } from "./engine-client.js";
import type { McpSafetyConfig } from "./config.js";
import { checkAllowlist, checkLoadCaps } from "./safety.js";
import { compareReports } from "./compare.js";

export interface ToolContext {
	client: EngineClient;
	config: McpSafetyConfig;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface McpTool {
	name: string;
	description: string;
	/** JSON Schema for the tool's arguments (passed straight to `tools/list`). */
	inputSchema: Record<string, unknown>;
	/** Whether the tool only reads (never mutates state or sends load). */
	readOnly: boolean;
	handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// --- Result helpers ----------------------------------------------------------

function jsonResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap an engine call so transport errors surface as tool errors, not crashes. */
async function callEngine(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return jsonResult(await fn());
	} catch (err) {
		if (err instanceof EngineRequestError) {
			return errorResult(`Engine error (${err.status}): ${err.body || err.message}`);
		}
		const msg = err instanceof Error ? err.message : String(err);
		// A connection refusal almost always means the engine/app isn't running.
		if (/ECONNREFUSED|fetch failed|abort/i.test(msg)) {
			return errorResult(
				`Could not reach the Vayu engine. Make sure the Vayu app is running, then retry. (${msg})`
			);
		}
		return errorResult(`Unexpected error: ${msg}`);
	}
}

// --- Argument coercion helpers ----------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === "string" ? v : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
	const v = str(args, key);
	if (v === undefined || v === "") throw new ToolArgError(`"${key}" is required.`);
	return v;
}

class ToolArgError extends Error {}

/** Build the engine `/request` or `/run` body from loose tool arguments. */
function buildExecutionPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		method: str(args, "method") ?? "GET",
		url: requireStr(args, "url"),
	};
	if (args.headers && typeof args.headers === "object") payload.headers = args.headers;
	const bodyContent = str(args, "body");
	if (bodyContent !== undefined) {
		payload.body = { type: str(args, "bodyType") ?? "text", content: bodyContent };
	}
	for (const key of ["requestId", "environmentId", "preRequestScript", "postRequestScript"]) {
		const v = str(args, key);
		if (v !== undefined) payload[key] = v;
	}
	return payload;
}

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	{
		name: "get_engine_health",
		description:
			"Check the Vayu engine's status and version. Use this first to confirm Vayu is running.",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: (_args, ctx) => callEngine(() => ctx.client.health()),
	},
	{
		name: "list_collections",
		description: "List all request collections (folders that organize saved requests).",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: (_args, ctx) => callEngine(() => ctx.client.listCollections()),
	},
	{
		name: "list_requests",
		description: "List the saved requests inside a collection.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { collectionId: { type: "string", description: "Collection ID to list." } },
			required: ["collectionId"],
			additionalProperties: false,
		},
		handler: (args, ctx) =>
			callEngine(() => ctx.client.listRequests(requireStr(args, "collectionId"))),
	},
	{
		name: "list_environments",
		description: "List all environments (named sets of variables like baseUrl, apiKey).",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: (_args, ctx) => callEngine(() => ctx.client.listEnvironments()),
	},
	{
		name: "list_runs",
		description:
			"List past runs (both single Design-mode requests and load tests), newest first.",
		readOnly: true,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: (_args, ctx) => callEngine(() => ctx.client.listRuns()),
	},
	{
		name: "get_run_report",
		description:
			"Get the full report for a completed run: summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown. Ideal input for analyzing performance.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string", description: "Run ID to fetch." } },
			required: ["runId"],
			additionalProperties: false,
		},
		handler: (args, ctx) =>
			callEngine(() => ctx.client.getRunReport(requireStr(args, "runId"))),
	},
	{
		name: "run_request",
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string", description: "HTTP method (default GET)." },
				url: { type: "string", description: "Fully-resolved request URL." },
				headers: { type: "object", description: "Request headers as a string map." },
				body: { type: "string", description: "Request body content." },
				bodyType: {
					type: "string",
					description:
						"Body type: json, text, form-data, x-www-form-urlencoded (default text).",
				},
				requestId: { type: "string", description: "Optional saved request ID to link." },
				environmentId: {
					type: "string",
					description: "Optional environment ID for variables.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const url = requireStr(args, "url");
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			return callEngine(() => ctx.client.executeRequest(buildExecutionPayload(args)));
		},
	},
	{
		name: "start_load_run",
		description:
			"Start a load test against a URL. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. Call once without `confirmed` to get a preview of what will run, then again with `confirmed: true` to actually start it.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: {
				method: { type: "string" },
				url: { type: "string", description: "Fully-resolved target URL." },
				headers: { type: "object" },
				body: { type: "string" },
				bodyType: { type: "string" },
				mode: {
					type: "string",
					description: "constant_rps | constant_concurrency | ramp_up | iterations.",
				},
				concurrency: { type: "number", description: "Target in-flight requests." },
				startConcurrency: {
					type: "number",
					description: "Ramp start concurrency (ramp_up).",
				},
				duration: {
					type: "string",
					description: 'Duration, e.g. "60s" (non-iterations modes).',
				},
				rampUpDuration: { type: "string", description: "Ramp time (ramp_up)." },
				iterations: { type: "number", description: "Iteration count (iterations mode)." },
				targetRps: { type: "number", description: "Target RPS (constant_rps)." },
				maxInFlight: { type: "number", description: "In-flight cap (constant_rps only)." },
				requestId: { type: "string" },
				environmentId: { type: "string" },
				tests: { type: "string", description: "Optional deferred validation script." },
				confirmed: {
					type: "boolean",
					description: "Set true to actually start the run. Omit/false to preview only.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const url = requireStr(args, "url");
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);

			const loadParams = {
				mode: str(args, "mode"),
				targetRps: typeof args.targetRps === "number" ? args.targetRps : undefined,
				concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
				duration: (args.duration as string | number | undefined) ?? undefined,
			};
			const caps = checkLoadCaps(loadParams, ctx.config);
			if (!caps.ok) return errorResult(caps.error!);

			const payload: Record<string, unknown> = {
				...buildExecutionPayload(args),
				mode: str(args, "mode") ?? "constant_concurrency",
			};
			for (const key of [
				"concurrency",
				"startConcurrency",
				"iterations",
				"targetRps",
				"maxInFlight",
			]) {
				if (typeof args[key] === "number") payload[key] = args[key];
			}
			for (const key of ["duration", "rampUpDuration", "tests"]) {
				const v = str(args, key);
				if (v !== undefined) payload[key] = v;
			}

			if (args.confirmed !== true) {
				return textResult(
					"AWAITING CONFIRMATION — no run was started.\n\n" +
						"This is a preview. To start the load test, call start_load_run again with confirmed: true and the same arguments.\n\n" +
						`Planned run:\n${JSON.stringify(payload, null, 2)}`
				);
			}
			return callEngine(() => ctx.client.startRun(payload));
		},
	},
	{
		name: "stop_run",
		description: "Stop an in-progress load test.",
		readOnly: false,
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string", description: "Run ID to stop." } },
			required: ["runId"],
			additionalProperties: false,
		},
		handler: (args, ctx) => callEngine(() => ctx.client.stopRun(requireStr(args, "runId"))),
	},
	{
		name: "get_live_metrics",
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				runId: { type: "string", description: "Run ID to sample." },
				limit: {
					type: "number",
					description: "How many recent ticks to return (default 10).",
				},
			},
			required: ["runId"],
			additionalProperties: false,
		},
		handler: (args, ctx) => {
			const runId = requireStr(args, "runId");
			const limit = typeof args.limit === "number" ? args.limit : 10;
			return callEngine(() => ctx.client.getLiveMetricsSnapshot(runId, limit));
		},
	},
	{
		name: "compare_runs",
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix. Use to answer 'did this change regress performance?'.",
		readOnly: true,
		inputSchema: {
			type: "object",
			properties: {
				baseRunId: { type: "string", description: "Baseline run ID (e.g. main)." },
				targetRunId: {
					type: "string",
					description: "Comparison run ID (e.g. the change).",
				},
			},
			required: ["baseRunId", "targetRunId"],
			additionalProperties: false,
		},
		handler: async (args, ctx) => {
			const baseRunId = requireStr(args, "baseRunId");
			const targetRunId = requireStr(args, "targetRunId");
			try {
				const [base, target] = await Promise.all([
					ctx.client.getRunReport(baseRunId),
					ctx.client.getRunReport(targetRunId),
				]);
				return jsonResult(
					compareReports(
						baseRunId,
						targetRunId,
						base as Record<string, unknown>,
						target as Record<string, unknown>
					)
				);
			} catch (err) {
				if (err instanceof EngineRequestError) {
					return errorResult(`Engine error (${err.status}): ${err.body || err.message}`);
				}
				return errorResult(
					`Unexpected error: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		},
	},
];

/** Look up a tool by name. */
export function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/**
 * Dispatch a `tools/call`. Converts argument errors into tool errors so the
 * agent gets a readable message instead of a protocol failure.
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolResult> {
	const tool = findTool(name);
	if (!tool) return errorResult(`Unknown tool: ${name}`);
	// Write tools are disabled unless the user opted in (load runs excepted —
	// they are gated by confirmation + caps instead).
	try {
		return await tool.handler(args, ctx);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
}
