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
 *        for structured results. Transport-agnostic - the same registry backs
 *        both the Streamable HTTP server (Electron) and the stdio CLI.
 */

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { EngineClient } from "./engine-client.js";
import { EngineRequestError } from "./engine-client.js";
import type { McpSafetyConfig } from "./config.js";
import { checkAllowlist, checkLoadCaps } from "./safety.js";
import { compareReports } from "./compare.js";
import {
	loadResolutionContext,
	composeAuth,
	composeSavedRequest,
	type AuthRecord,
	type Resolver,
	type ResolutionContext,
	type SavedRequestLike,
} from "./resolve.js";

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
 * Capability class surfaced in Settings for per-tool control; each maps to a
 * distinct gate profile: `read` (inspection, ungated), `execute` (sends a
 * request to a target host - allowlist), `write` (mutates saved data/config -
 * write toggle), `load` (starts/stops load tests - allowlist + caps + confirm).
 */
export type ToolCategory = "read" | "execute" | "write" | "load";

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

/**
 * Build the engine `/request` or `/run` body from loose tool arguments. When a
 * `resolver` is supplied, `{{variables}}` are substituted in the URL, header
 * keys/values, and body content (the app resolves these renderer-side before
 * the engine ever sees them; MCP must do the same). `opts.url` lets the caller
 * pass an already-resolved URL (it is resolved once, up front, for the
 * allowlist check). The body is emitted as `{ mode, content }` - the shape the
 * engine's `deserialize_request` reads (it keys off `mode`, not `type`).
 */
function buildExecutionPayload(
	args: Record<string, unknown>,
	opts?: { resolver?: Resolver; url?: string }
): Record<string, unknown> {
	const rs = (s: string): string => opts?.resolver?.resolveString(s) ?? s;
	const payload: Record<string, unknown> = {
		method: str(args, "method") ?? "GET",
		url: opts?.url ?? rs(requireStr(args, "url")),
	};
	if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
			headers[rs(key)] = rs(String(value));
		}
		payload.headers = headers;
	}
	const bodyContent = str(args, "body");
	if (bodyContent !== undefined) {
		payload.body = { mode: str(args, "bodyType") ?? "text", content: rs(bodyContent) };
	}
	// preRequestScript/postRequestScript here are an agent-supplied ad-hoc
	// script, not collection-chain composition - there is no chain to collect
	// parts from, so this deliberately keeps sending the legacy singular key
	// (still accepted by the engine's `read_script`), not `ScriptPart[]`.
	for (const key of ["requestId", "environmentId", "preRequestScript", "postRequestScript"]) {
		const v = str(args, key);
		if (v !== undefined) payload[key] = v;
	}
	return payload;
}

/** Regex used only to *detect* whether resolution is needed (non-global: no lastIndex state). */
const TEMPLATE_RE = /\{\{[^{}]+\}\}/;

/** Read an optional agent-supplied `auth` block (a `{ mode, … }` object). */
function readAuthArg(args: Record<string, unknown>): AuthRecord | undefined {
	const a = args.auth;
	return a && typeof a === "object" && !Array.isArray(a) ? (a as AuthRecord) : undefined;
}

/**
 * Build the resolution scope for an ad-hoc execute/load call. Loading the
 * variable sources (globals/collection/environment) costs engine round-trips,
 * so we skip it entirely unless the call actually needs it: some field carries
 * a `{{template}}`, or the auth is `inherit` (which must walk the collection
 * chain). When nothing needs resolving, an identity context is returned.
 */
async function resolutionScopeFor(
	args: Record<string, unknown>,
	client: EngineClient,
	signal?: AbortSignal
): Promise<ResolutionContext> {
	const authArg = readAuthArg(args);
	const templated = TEMPLATE_RE.test(
		JSON.stringify([str(args, "url"), args.headers ?? null, str(args, "body"), authArg ?? null])
	);
	if (!templated && authArg?.mode !== "inherit") {
		return { chain: [], resolveString: (s) => s, resolveObject: (v) => v };
	}
	return loadResolutionContext(client, {
		collectionId: str(args, "collectionId"),
		environmentId: str(args, "environmentId"),
		signal,
	});
}

// --- Shared input schema fragments ------------------------------------------

/** Optional resolution scope shared by the ad-hoc execute/load tools. */
const collectionIdInput = z
	.string()
	.optional()
	.describe(
		"Optional collection ID. Scopes variable resolution to that collection's variable chain and lets auth mode 'inherit' resolve against it."
	);

const environmentIdInput = z
	.string()
	.optional()
	.describe("Optional environment ID whose variables resolve {{templates}} in this request.");

/**
 * Optional auth block. Callers can copy a saved request's `auth` object verbatim
 * (read via list_requests). The engine applies it - bearer/basic/apikey and
 * oauth2 (using its token cache) - after `{{variables}}` inside it are resolved;
 * `inherit` resolves against the collection chain (supply collectionId).
 */
const authInput = z
	.object({ mode: z.string().describe("bearer | basic | apikey | oauth2 | inherit | none.") })
	.passthrough()
	.optional()
	.describe(
		"Optional auth block (e.g. { mode: 'bearer', token: '{{apiToken}}' }); the engine resolves and applies it."
	);

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

const smokeResultSchema = z.object({
	collectionId: z.string(),
	total: z.number(),
	passed: z.number(),
	failed: z.number(),
	skipped: z.number(),
	results: z.array(
		z.object({
			name: z.string(),
			method: z.string(),
			url: z.string(),
			ok: z.boolean(),
			statusCode: z.number().optional(),
			skipped: z.boolean().optional(),
			reason: z.string().optional(),
			error: z.string().optional(),
		})
	),
});

const configUpdateSchema = z
	.object({
		changedKeys: z.array(z.string()),
		restartRequired: z.array(z.string()),
	})
	.passthrough();

/**
 * Of the changed config keys, which require an engine restart to take effect.
 * The engine flags this in each entry's `label` ("… (Requires Restart)") - or an
 * explicit `requiresRestart` boolean if present.
 */
function restartRequiredAmong(configResponse: unknown, changedKeys: string[]): string[] {
	const raw = Array.isArray(configResponse)
		? configResponse
		: configResponse && typeof configResponse === "object"
			? ((configResponse as Record<string, unknown>).entries ?? [])
			: [];
	const entries = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	const byKey = new Map(entries.map((e) => [String(e.key), e]));
	return changedKeys.filter((key) => {
		const e = byKey.get(key);
		if (!e) return false;
		return e.requiresRestart === true || /requires restart/i.test(String(e.label ?? ""));
	});
}

/** Convert a `{key: value}` header map to the engine's KeyValueEntry[] shape. */
function toKeyValueEntries(
	headers: unknown
): Array<{ key: string; value: string; enabled: boolean }> {
	if (!headers || typeof headers !== "object") return [];
	return Object.entries(headers as Record<string, unknown>).map(([key, value]) => ({
		key,
		value: String(value),
		enabled: true,
	}));
}

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
		category: "execute",
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app (environment > collection chain > globals). Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. (To replay a saved request with its stored auth and scripts across a whole collection, use run_collection_smoke.)",
		readOnly: false,
		annotations: {
			title: "Send a request",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional().describe("HTTP method (default GET)."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			headers: z.record(z.string()).optional().describe("Request headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type: json, text, form-data, x-www-form-urlencoded (default text)."
				),
			auth: authInput,
			requestId: z.string().optional().describe("Optional saved request ID to link."),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
		},
		handler: async (args, ctx, signal) => {
			const rc = await resolutionScopeFor(args, ctx.client, signal);
			const url = rc.resolveString(requireStr(args, "url"));
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			const payload = buildExecutionPayload(args, { resolver: rc, url });
			const authArg = readAuthArg(args);
			if (authArg) {
				const auth = composeAuth(authArg, rc.chain, rc);
				if (auth) payload.auth = auth;
			}
			return callEngine(() => ctx.client.executeRequest(payload, signal));
		},
	},
	{
		name: "update_engine_config",
		category: "write",
		description:
			"Update one or more engine configuration entries. GUARDED: requires write access to be enabled in Vayu Settings. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine RESTART to take effect - the result lists those under `restartRequired`; they are saved but the running engine keeps the old value until the user restarts it (Vayu Settings → restart engine, or relaunch).",
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
		outputSchema: configUpdateSchema,
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
			try {
				const updated = await ctx.client.updateConfig({ entries }, signal);
				const changedKeys = Object.keys(entries as Record<string, unknown>);
				// Best-effort: read back to flag restart-required keys. Failure here
				// must not fail the (already-applied) update.
				let restartRequired: string[] = [];
				try {
					const cfg = await ctx.client.getConfig(signal);
					restartRequired = restartRequiredAmong(cfg, changedKeys);
				} catch {
					/* leave restartRequired empty */
				}
				const result: Record<string, unknown> = { changedKeys, restartRequired, updated };
				if (restartRequired.length > 0) {
					const note =
						`Updated ${changedKeys.length} config key(s). ⚠ Restart required for: ` +
						`${restartRequired.join(", ")}. These are saved, but the running engine keeps ` +
						`the old values until it is restarted (Vayu Settings → restart engine, or relaunch the app).`;
					return {
						content: [
							{ type: "text", text: `${note}\n\n${JSON.stringify(result, null, 2)}` },
						],
						structuredContent: result,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					structuredContent: result,
				};
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "create_request",
		category: "write",
		description:
			"Create a saved request inside a collection (stores it; does not send it). GUARDED: requires write access to be enabled in Vayu Settings. The URL may contain {{variables}} since it is only saved, not executed.",
		readOnly: false,
		annotations: {
			title: "Create saved request",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to add the request to."),
			name: z.string().describe("Display name for the saved request."),
			url: z.string().describe("Request URL (may contain {{variables}})."),
			method: z.string().optional().describe("HTTP method (default GET)."),
			headers: z.record(z.string()).optional().describe("Headers as a string map."),
			body: z.string().optional().describe("Request body content."),
			bodyType: z.string().optional().describe("Body type: json, text, ... (default text)."),
			description: z.string().optional(),
		},
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					"Writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
				);
			}
			const payload: Record<string, unknown> = {
				collectionId: requireStr(args, "collectionId"),
				name: requireStr(args, "name"),
				url: requireStr(args, "url"),
				method: str(args, "method") ?? "GET",
			};
			if (args.headers && typeof args.headers === "object") {
				payload.headers = toKeyValueEntries(args.headers);
			}
			const body = str(args, "body");
			if (body !== undefined) {
				const bodyType = str(args, "bodyType") ?? "text";
				// The engine stores the body blob verbatim; the canonical shape keys
				// off `mode` (not `type`), so a `type`-keyed body would not round-trip
				// in the app. `bodyType` mirrors it into the denormalized column.
				payload.body = { mode: bodyType, content: body };
				payload.bodyType = bodyType;
			}
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			return callEngine(() => ctx.client.createRequest(payload, signal));
		},
	},
	{
		name: "update_environment",
		category: "write",
		description:
			"Set or overwrite variables on an environment (merges with the existing variables - other variables are preserved). GUARDED: requires write access to be enabled in Vayu Settings.",
		readOnly: false,
		annotations: {
			title: "Update environment",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			environmentId: z.string().describe("Environment ID to update."),
			variables: z
				.record(z.string())
				.describe("Variables to set/overwrite as a key -> value string map."),
			name: z.string().optional().describe("Optional new name for the environment."),
		},
		handler: async (args, ctx, signal) => {
			if (!ctx.config.allowWrites) {
				return errorResult(
					"Writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
				);
			}
			const environmentId = requireStr(args, "environmentId");
			const vars = args.variables;
			if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
				return errorResult('"variables" must be an object mapping names to values.');
			}
			// Fetch the current env so we merge (upsert replaces the whole blob) and
			// keep the existing name (which the engine requires).
			let existing: Record<string, unknown>;
			try {
				existing = ((await ctx.client.getEnvironment(environmentId, signal)) ??
					{}) as Record<string, unknown>;
			} catch (err) {
				return engineErrorResult(err);
			}
			const mergedVars: Record<string, unknown> =
				existing.variables && typeof existing.variables === "object"
					? { ...(existing.variables as Record<string, unknown>) }
					: {};
			for (const [key, value] of Object.entries(vars as Record<string, string>)) {
				mergedVars[key] = { value: String(value), enabled: true };
			}
			const payload: Record<string, unknown> = {
				id: environmentId,
				name: str(args, "name") ?? (typeof existing.name === "string" ? existing.name : ""),
				variables: mergedVars,
			};
			return callEngine(() => ctx.client.upsertEnvironment(payload, signal));
		},
	},
	{
		name: "run_collection_smoke",
		category: "execute",
		description:
			"Execute every saved request in a collection once and return a pass/fail matrix (a request passes on a 2xx/3xx status with all its tests passing). Each request is composed exactly as the app would send it: {{variables}} resolved (environment > collection chain > globals), the request's stored auth applied (inheriting from the collection chain, incl. OAuth2), and its collection-chain + own pre/post scripts run. Each request's resolved host must be on the allowlist; requests whose host still cannot be verified (e.g. a variable did not resolve and allow-all is off) are skipped. Sends real traffic but does not modify Vayu data.",
		readOnly: false,
		annotations: {
			title: "Run collection smoke test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests to run."),
			environmentId: z
				.string()
				.optional()
				.describe("Environment for variable resolution during execution."),
		},
		outputSchema: smokeResultSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			let requests: unknown;
			let rc: ResolutionContext;
			try {
				// Fetch the requests and the resolution scope (collection chain +
				// variable sources) concurrently - the scope is shared across every
				// request in the collection.
				[requests, rc] = await Promise.all([
					ctx.client.listRequests(collectionId, signal),
					loadResolutionContext(ctx.client, { collectionId, environmentId, signal }),
				]);
			} catch (err) {
				return engineErrorResult(err);
			}
			const list = Array.isArray(requests) ? requests : [];
			const results: Array<Record<string, unknown>> = [];
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			for (const item of list) {
				const req = (item ?? {}) as SavedRequestLike;
				const name = String(req.name ?? req.id ?? "request");
				// Compose the request the same way the app's Send does: resolve
				// variables, apply stored/inherited auth, and compose scripts.
				const outgoing = composeSavedRequest(req, rc.chain, rc, environmentId);
				const method = outgoing.method;
				const url = outgoing.url;

				const gate = checkAllowlist(url, ctx.config);
				if (!gate.ok) {
					results.push({
						name,
						method,
						url,
						ok: false,
						skipped: true,
						reason: gate.error,
					});
					skipped++;
					continue;
				}
				try {
					const resp = ((await ctx.client.executeRequest(outgoing, signal)) ??
						{}) as Record<string, unknown>;
					const code =
						typeof resp.status === "number"
							? resp.status
							: typeof resp.statusCode === "number"
								? resp.statusCode
								: 0;
					const testsOk = Array.isArray(resp.testResults)
						? (resp.testResults as Array<{ passed?: boolean }>).every(
								(t) => t.passed !== false
							)
						: true;
					const ok = code >= 200 && code < 400 && testsOk;
					results.push({ name, method, url, ok, statusCode: code });
					if (ok) passed++;
					else failed++;
				} catch (err) {
					results.push({
						name,
						method,
						url,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
				}
			}

			return structuredResult({
				collectionId,
				total: list.length,
				passed,
				failed,
				skipped,
				results,
			});
		},
	},
	{
		name: "start_load_run",
		category: "load",
		description:
			"Start a load test against a URL. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given; pass an `auth` block to authenticate the load (bearer/basic/apikey/oauth2, applied engine-side). Confirmation is required: if the client supports elicitation the user is prompted directly; otherwise call once for a preview, then again with `confirmed: true`.",
		readOnly: false,
		annotations: {
			title: "Start load test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional(),
			url: z.string().describe("Target URL (may contain {{variables}})."),
			headers: z.record(z.string()).optional(),
			body: z.string().optional(),
			bodyType: z.string().optional(),
			auth: authInput,
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
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			tests: z.string().optional().describe("Optional deferred validation script."),
			confirmed: z
				.boolean()
				.optional()
				.describe(
					"Fallback confirmation for clients without elicitation: set true to actually start the run."
				),
		},
		handler: async (args, ctx, signal) => {
			const rc = await resolutionScopeFor(args, ctx.client, signal);
			const url = rc.resolveString(requireStr(args, "url"));
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
				...buildExecutionPayload(args, { resolver: rc, url }),
				mode: str(args, "mode") ?? "constant_concurrency",
			};
			const authArg = readAuthArg(args);
			if (authArg) {
				const auth = composeAuth(authArg, rc.chain, rc);
				if (auth) payload.auth = auth;
			}
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
						return textResult("Load run not started - the user declined.");
					}
					return callEngine(() => ctx.client.startRun(payload, signal));
				} catch {
					// Client can't elicit - fall through to the flag-based gate.
				}
			}

			// Fallback gate: preview unless explicitly confirmed.
			if (args.confirmed !== true) {
				return textResult(
					"AWAITING CONFIRMATION - no run was started.\n\n" +
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
		category: "read",
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
		category: "read",
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
