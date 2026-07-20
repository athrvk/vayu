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
 *        result. Schemas are Zod (the SDK validates arguments and generates the
 *        JSON Schema for `tools/list`); tools carry MCP annotations (readOnly /
 *        destructive hints + a display title) and some declare an output schema
 *        for structured results. Transport-agnostic — the same registry backs
 *        both the Streamable HTTP server (Electron) and the stdio CLI.
 */

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { EngineClient } from "./engine-client.js";
import { EngineRequestError } from "./engine-client.js";
import type { McpSafetyConfig } from "./config.js";
import { checkAllowlist, checkLoadCaps } from "./safety.js";
import { compareReports } from "./compare.js";

// --- Elicitation -------------------------------------------------------------

/** A restricted, flat object schema the client renders as a form. */
export interface ElicitParams {
	message: string;
	requestedSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ElicitOutcome {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

/** Ask the human via the client; throws if the client can't elicit. */
export type ElicitFn = (params: ElicitParams) => Promise<ElicitOutcome>;

export interface ToolContext {
	client: EngineClient;
	config: McpSafetyConfig;
	/**
	 * Present when the connected client supports elicitation; lets a tool ask the
	 * human to confirm. Absent (or throwing) → the tool falls back to its
	 * agent-side gate (e.g. the `confirmed` flag).
	 */
	elicit?: ElicitFn;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	/** Present for tools that declare an `outputSchema` (validated by the SDK). */
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Feature grouping surfaced in Settings so the user can enable/disable tools by
 * area: `read` (inspection), `write` (sends a request / mutates config), `load`
 * (generates or observes load tests).
 */
export type ToolCategory = "read" | "write" | "load";

export interface McpTool {
	name: string;
	description: string;
	/** Zod raw shape for the tool's arguments (SDK validates + builds JSON Schema). */
	inputSchema: z.ZodRawShape;
	/** Optional Zod schema for structured results (SDK validates `structuredContent`). */
	outputSchema?: z.ZodTypeAny;
	/** MCP tool annotations (title + read-only/destructive/idempotent/open-world hints). */
	annotations: ToolAnnotations;
	/** Whether the tool only reads (never mutates state or sends load). */
	readOnly: boolean;
	/** Feature group for the Settings tool list. */
	category: ToolCategory;
	handler: (
		args: Record<string, unknown>,
		ctx: ToolContext,
		signal?: AbortSignal
	) => Promise<ToolResult>;
}

/** Tool metadata safe to cross the IPC boundary (no handler/schema). */
export interface McpToolInfo {
	name: string;
	description: string;
	category: ToolCategory;
	readOnly: boolean;
}

// --- Result helpers ----------------------------------------------------------

function jsonResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Result that carries both a text rendering and structured content. */
function structuredResult(value: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		structuredContent: value,
	};
}

function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function engineErrorResult(err: unknown): ToolResult {
	if (err instanceof EngineRequestError) {
		return errorResult(`Engine error (${err.status}): ${err.body || err.message}`);
	}
	const msg = err instanceof Error ? err.message : String(err);
	if (/ECONNREFUSED|fetch failed|abort/i.test(msg)) {
		return errorResult(
			`Could not reach the Vayu engine. Make sure the Vayu app is running, then retry. (${msg})`
		);
	}
	return errorResult(`Unexpected error: ${msg}`);
}

/** Wrap an engine call so transport errors surface as tool errors, not crashes. */
async function callEngine(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return jsonResult(await fn());
	} catch (err) {
		return engineErrorResult(err);
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

// --- Structured output schemas ----------------------------------------------

const metricDeltaSchema = z.object({
	metric: z.string(),
	base: z.number().nullable(),
	target: z.number().nullable(),
	delta: z.number().nullable(),
	pctChange: z.number().nullable(),
});

const runComparisonSchema = z.object({
	baseRunId: z.string(),
	targetRunId: z.string(),
	latency: z.array(metricDeltaSchema),
	throughput: z.array(metricDeltaSchema),
	reliability: z.array(metricDeltaSchema),
	statusCodes: z.record(z.object({ base: z.number(), target: z.number() })),
});

const engineHealthSchema = z
	.object({ status: z.string(), version: z.string().optional() })
	.passthrough();

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	{
		name: "get_engine_health",
		category: "read",
		description:
			"Check the Vayu engine's status and version. Use this first to confirm Vayu is running.",
		readOnly: true,
		annotations: {
			title: "Check engine health",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		outputSchema: engineHealthSchema,
		handler: async (_args, ctx, signal) => {
			try {
				const value = await ctx.client.health(signal);
				return value && typeof value === "object"
					? structuredResult(value as Record<string, unknown>)
					: jsonResult(value);
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "list_collections",
		category: "read",
		description: "List all request collections (folders that organize saved requests).",
		readOnly: true,
		annotations: {
			title: "List collections",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listCollections(signal)),
	},
	{
		name: "list_requests",
		category: "read",
		description: "List the saved requests inside a collection.",
		readOnly: true,
		annotations: {
			title: "List requests",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { collectionId: z.string().describe("Collection ID to list.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.listRequests(requireStr(args, "collectionId"), signal)),
	},
	{
		name: "list_environments",
		category: "read",
		description: "List all environments (named sets of variables like baseUrl, apiKey).",
		readOnly: true,
		annotations: {
			title: "List environments",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listEnvironments(signal)),
	},
	{
		name: "list_runs",
		category: "read",
		description:
			"List past runs (both single Design-mode requests and load tests), newest first.",
		readOnly: true,
		annotations: {
			title: "List runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listRuns(signal)),
	},
	{
		name: "get_run_report",
		category: "read",
		description:
			"Get the full report for a completed run: summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown. Ideal input for analyzing performance.",
		readOnly: true,
		annotations: {
			title: "Get run report",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to fetch.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.getRunReport(requireStr(args, "runId"), signal)),
	},
	{
		name: "get_engine_config",
		category: "read",
		description:
			"Get the engine's tunable configuration entries (workers, timeouts, connection limits, buffer sizes, etc.), each with its current value, default, type, and allowed range.",
		readOnly: true,
		annotations: {
			title: "Get engine config",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.getConfig(signal)),
	},
	{
		name: "run_request",
		category: "write",
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist.",
		readOnly: false,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional().describe("HTTP method (default GET)."),
			url: z.string().describe("Fully-resolved request URL."),
			headers: z.record(z.string()).optional().describe("Request headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type: json, text, form-data, x-www-form-urlencoded (default text)."
				),
			requestId: z.string().optional().describe("Optional saved request ID to link."),
			environmentId: z.string().optional().describe("Optional environment ID for variables."),
		},
		handler: async (args, ctx, signal) => {
			const url = requireStr(args, "url");
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			return callEngine(() => ctx.client.executeRequest(buildExecutionPayload(args), signal));
		},
	},
	{
		name: "update_engine_config",
		category: "write",
		description:
			"Update one or more engine configuration entries. GUARDED: requires write access to be enabled in Vayu Settings. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine restart to take effect.",
		readOnly: false,
		annotations: {
			title: "Update engine config",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			entries: z
				.record(z.string())
				.describe('Map of config key to new value, e.g. { "workers": "8" }.'),
		},
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					"Config writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
				);
			}
			const entries = args.entries;
			if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
				return errorResult('"entries" must be an object mapping config keys to values.');
			}
			return callEngine(() => ctx.client.updateConfig({ entries }, signal));
		},
	},
	{
		name: "start_load_run",
		category: "load",
		description:
			"Start a load test against a URL. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. Confirmation is required: if the client supports elicitation the user is prompted directly; otherwise call once for a preview, then again with `confirmed: true`.",
		readOnly: false,
		annotations: {
			title: "Start load test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional(),
			url: z.string().describe("Fully-resolved target URL."),
			headers: z.record(z.string()).optional(),
			body: z.string().optional(),
			bodyType: z.string().optional(),
			mode: z
				.string()
				.optional()
				.describe("constant_rps | constant_concurrency | ramp_up | iterations."),
			concurrency: z.number().optional().describe("Target in-flight requests."),
			startConcurrency: z.number().optional().describe("Ramp start concurrency (ramp_up)."),
			duration: z
				.string()
				.optional()
				.describe('Duration, e.g. "60s" (non-iterations modes).'),
			rampUpDuration: z.string().optional().describe("Ramp time (ramp_up)."),
			iterations: z.number().optional().describe("Iteration count (iterations mode)."),
			targetRps: z.number().optional().describe("Target RPS (constant_rps)."),
			maxInFlight: z.number().optional().describe("In-flight cap (constant_rps only)."),
			requestId: z.string().optional(),
			environmentId: z.string().optional(),
			tests: z.string().optional().describe("Optional deferred validation script."),
			confirmed: z
				.boolean()
				.optional()
				.describe(
					"Fallback confirmation for clients without elicitation: set true to actually start the run."
				),
		},
		handler: async (args, ctx, signal) => {
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

			const summary = `Start a load test against ${payload.url} (mode: ${payload.mode})?`;

			// Preferred path: ask the human directly via the client.
			if (ctx.elicit) {
				try {
					const outcome = await ctx.elicit({
						message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
						requestedSchema: {
							type: "object",
							properties: {
								proceed: {
									type: "boolean",
									title: "Start the load test",
									description: "Confirm to generate load now.",
								},
							},
							required: ["proceed"],
						},
					});
					if (outcome.action !== "accept" || outcome.content?.proceed === false) {
						return textResult("Load run not started — the user declined.");
					}
					return callEngine(() => ctx.client.startRun(payload, signal));
				} catch {
					// Client can't elicit — fall through to the flag-based gate.
				}
			}

			// Fallback gate: preview unless explicitly confirmed.
			if (args.confirmed !== true) {
				return textResult(
					"AWAITING CONFIRMATION — no run was started.\n\n" +
						"This is a preview. To start the load test, call start_load_run again with confirmed: true and the same arguments.\n\n" +
						`Planned run:\n${JSON.stringify(payload, null, 2)}`
				);
			}
			return callEngine(() => ctx.client.startRun(payload, signal));
		},
	},
	{
		name: "stop_run",
		category: "load",
		description: "Stop an in-progress load test.",
		readOnly: false,
		annotations: {
			title: "Stop run",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: { runId: z.string().describe("Run ID to stop.") },
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopRun(requireStr(args, "runId"), signal)),
	},
	{
		name: "get_live_metrics",
		category: "load",
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream.",
		readOnly: true,
		annotations: {
			title: "Get live metrics",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to sample."),
			limit: z.number().optional().describe("How many recent ticks to return (default 10)."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			const limit = typeof args.limit === "number" ? args.limit : 10;
			return callEngine(() =>
				ctx.client.getLiveMetricsSnapshot(runId, limit, undefined, signal)
			);
		},
	},
	{
		name: "compare_runs",
		category: "load",
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix. Use to answer 'did this change regress performance?'.",
		readOnly: true,
		annotations: {
			title: "Compare runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			baseRunId: z.string().describe("Baseline run ID (e.g. main)."),
			targetRunId: z.string().describe("Comparison run ID (e.g. the change)."),
		},
		outputSchema: runComparisonSchema,
		handler: async (args, ctx, signal) => {
			const baseRunId = requireStr(args, "baseRunId");
			const targetRunId = requireStr(args, "targetRunId");
			try {
				const [base, target] = await Promise.all([
					ctx.client.getRunReport(baseRunId, signal),
					ctx.client.getRunReport(targetRunId, signal),
				]);
				const comparison = compareReports(
					baseRunId,
					targetRunId,
					base as Record<string, unknown>,
					target as Record<string, unknown>
				);
				return structuredResult(comparison as unknown as Record<string, unknown>);
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
];

/** Look up a tool by name. */
export function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** IPC-safe metadata for every tool, for the Settings tool list. */
export function toolCatalog(): McpToolInfo[] {
	return TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		category: t.category,
		readOnly: t.readOnly,
	}));
}

/**
 * Dispatch a `tools/call`. Converts argument errors into tool errors so the
 * agent gets a readable message instead of a protocol failure. Used directly by
 * the unit tests; the SDK server registers each tool's handler and validates
 * arguments via the Zod `inputSchema` before dispatch.
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const tool = findTool(name);
	if (!tool) return errorResult(`Unknown tool: ${name}`);
	// Tools the user switched off in Settings are rejected (and are also omitted
	// from tools/list, so a well-behaved client won't call them).
	if (ctx.config.disabledTools.includes(name)) {
		return errorResult(`Tool "${name}" is disabled in Vayu Settings → MCP.`);
	}
	try {
		return await tool.handler(args, ctx, signal);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
}
