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
import { EngineRequestError, EngineTimeoutError } from "./engine-client.js";
import type { McpSafetyConfig } from "./config.js";
import type { LoadRunParams } from "./safety.js";
import {
	checkAllowlist,
	checkLoadCaps,
	checkMonitorHost,
	defaultDurationUnderCap,
} from "./safety.js";
import { compareReports } from "./compare.js";
import { HTTP_VERSIONS } from "./http-versions.js";

/** An auth block as stored/forwarded (discriminated by `mode`). */
type AuthRecord = Record<string, unknown> & { mode?: string };

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

// --- Data-change notification ------------------------------------------------

/**
 * The data families an MCP call can change, named as the renderer's query cache
 * groups them. An MCP call mutates the engine from the main process, so the
 * renderer learns about it only if it is told: `refetchOnWindowFocus` is off
 * app-wide, and nothing else crosses the process boundary.
 *
 * Mirrored as `McpDataEntity` in `app/src/types/domain.ts`, because production
 * code under `electron/` cannot import from `app/src` (see the rationale in
 * `tsconfig.node.json`). `data-changed.conformance.test.ts` keeps the two
 * copies honest, and the renderer's mapping is exhaustive over this union, so
 * a new entity fails to compile until it has a reader.
 */
export const MCP_DATA_ENTITIES = [
	"collection",
	"request",
	"environment",
	"run",
	"cookie",
	"config",
] as const;

export type McpDataEntity = (typeof MCP_DATA_ENTITIES)[number];

/**
 * One thing changed. Invalidation only - no data rides across, the renderer
 * refetches through its normal query layer.
 *
 * The two scope hints are read from the call's own arguments and narrow the
 * invalidation to the caches that can have gone stale; both are absent when the
 * call named neither. They are hints, not identity: `requestId` on a
 * `run` event is the saved request a design run was linked to (the key
 * `runs.lastDesign` uses), not the run's own id.
 */
export interface McpDataChangedEvent {
	entity: McpDataEntity;
	/** The collection the call named, when it named one. */
	collectionId?: string;
	/** The saved request the call named, when it named one. */
	requestId?: string;
}

export interface ToolContext {
	client: EngineClient;
	config: McpSafetyConfig;
	/**
	 * Present when the connected client supports elicitation; lets a tool ask the
	 * human to confirm. Absent (or throwing) → the tool falls back to its
	 * agent-side gate (e.g. the `confirmed` flag).
	 */
	elicit?: ElicitFn;
	/**
	 * Called once per entity a successful call changed, so the renderer can
	 * invalidate the matching queries. Absent when there is nothing to notify -
	 * the stdio CLI has no window.
	 */
	onDataChanged?: (event: McpDataChangedEvent) => void;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	/** Present for tools that declare an `outputSchema` (validated by the SDK). */
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/**
 * Capability class surfaced in Settings for per-tool control; each maps to a
 * gate profile: `read` (inspection, ungated), `execute` (has an effect outside
 * this process without touching saved data - allowlist when it sends to a
 * target host, none when the effect is a loopback service the engine hosts, as
 * for the mock issuer), `write` (mutates saved data/config - write toggle),
 * `load` (starts/stops load tests - allowlist + caps + confirm).
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
	/**
	 * Feature group for the Settings tool list. Also says whether the tool only
	 * reads: `category === "read"` and nothing else does. A separate `readOnly`
	 * boolean lived here restating exactly that for all 21 tools, read by no one
	 * but its own test - the client-facing hint is `annotations.readOnlyHint`.
	 */
	category: ToolCategory;
	/**
	 * The data families a successful call changes. Required rather than
	 * defaulted, and deliberately not derived from `category`: an `execute` tool
	 * writes a history row and refills the cookie jar without being a "write",
	 * and a `load` tool writes run rows. A default would let a new tool ship
	 * silently invisible to the renderer, which is the bug this field exists to
	 * close; `[]` is a statement that the tool only reads.
	 */
	invalidates: readonly McpDataEntity[];
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

/**
 * Append a note to a result's text without disturbing its structured content.
 * For telling an agent what a call could *not* do - a caveat printed nowhere is
 * the same as not having noticed it.
 */
function withCaveat(result: ToolResult, caveat: string): ToolResult {
	if (!caveat) return result;
	return {
		...result,
		content: [...result.content, { type: "text" as const, text: caveat.trimStart() }],
	};
}

function engineErrorResult(err: unknown): ToolResult {
	if (err instanceof EngineRequestError) {
		return errorResult(`Engine error (${err.status}): ${err.body || err.message}`);
	}
	const msg = err instanceof Error ? err.message : String(err);
	// An abort means the engine was reachable and working - the opposite of the
	// "not running, retry" advice below. Whatever was in flight may well have
	// completed engine-side, so say so instead of inviting a second send.
	if (err instanceof EngineTimeoutError) {
		return errorResult(
			`The engine did not answer within this client's ${Math.round(err.timeoutMs / 1000)}s budget. ` +
				`It may still have completed the call - check run history (list_runs) before retrying. ` +
				`For a target that is legitimately this slow, raise the engine's "defaultTimeout" ` +
				`with update_engine_config.`
		);
	}
	if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(msg))) {
		return errorResult(
			`The call was cancelled before the engine answered. It may still have completed - ` +
				`check run history (list_runs) before retrying. (${msg})`
		);
	}
	if (/ECONNREFUSED|fetch failed/i.test(msg)) {
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
 * The refusal a data-mutating tool returns while the write toggle is off, or
 * null when writes are allowed. One wording for the collection / request /
 * environment tools: which of them was called does not change what the user has
 * to do about it, and a copy per tool is a copy per tool to drift.
 * `update_engine_config` keeps its own sentence, which names config.
 */
function writesDisabled(ctx: ToolContext): ToolResult | null {
	if (ctx.config.allowWrites) return null;
	return errorResult(
		"Writes are disabled. Turn on write access in Vayu Settings → MCP to allow this."
	);
}

/**
 * The run pinned as baseline for whatever saved request @p targetRunId ran -
 * `compare_runs`'s answer when the caller named no base.
 *
 * Resolution is the engine's, not a scan here: `GET /runs?baseline=true&
 * requestId=...` is ordered newest-first, so "the baseline" is its first row.
 * That is the same question the history view's vs-baseline strip asks, so an
 * agent and the UI compare a run against the same pin.
 *
 * Every way this can fail to find one throws a message naming the fix, because
 * the alternative - silently comparing against some other run - is a wrong
 * answer presented as a right one. A run that has no saved request behind it
 * (an ad-hoc load run) has nothing to resolve *through*, which is a different
 * problem from a request with no pin, and says so.
 */
async function resolveBaseline(
	targetRunId: string,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<string> {
	const run = (await ctx.client.getRun(targetRunId, signal)) as Record<string, unknown> | null;
	const requestId = run && typeof run.requestId === "string" ? run.requestId : null;
	if (!requestId) {
		throw new ToolArgError(
			`Run ${targetRunId} did not run a saved request, so it has no baseline to resolve. ` +
				`Pass "baseRunId" explicitly.`
		);
	}

	const page = (await ctx.client.listBaselineRuns(requestId, signal)) as {
		data?: Array<Record<string, unknown>>;
	} | null;
	const baseline = page?.data?.[0];
	const baseRunId = baseline && typeof baseline.id === "string" ? baseline.id : null;
	if (!baseRunId) {
		throw new ToolArgError(
			`No run is pinned as the baseline for request ${requestId}. Pin one in Vayu's ` +
				`history sidebar, or pass "baseRunId" explicitly.`
		);
	}
	if (baseRunId === targetRunId) {
		throw new ToolArgError(
			`Run ${targetRunId} is itself the baseline for request ${requestId}; there is ` +
				`nothing to compare it against. Pass "baseRunId" to compare it with another run.`
		);
	}
	return baseRunId;
}

// --- Confirmation gate -------------------------------------------------------

/**
 * Results that reported success while changing nothing - a confirmation
 * preview, or a prompt the user declined.
 *
 * Dispatch's rule is "a call that did not error changed what its tool
 * declares", and a gated tool is the one shape that breaks it: the preview's
 * whole point is that nothing happened, so emitting for it would refetch the
 * collection tree every time an agent asked what a delete would destroy - and
 * would say a run started when `start_load_run` only described one.
 *
 * A WeakSet rather than a field on {@link ToolResult}: the result object is
 * handed to the SDK verbatim (`server.ts`), so an extra property would be
 * serialized to the client as though it were part of the MCP result shape.
 */
const NOTHING_CHANGED = new WeakSet<ToolResult>();

/** Mark a successful result as having changed nothing (see {@link NOTHING_CHANGED}). */
function unchanged(result: ToolResult): ToolResult {
	NOTHING_CHANGED.add(result);
	return result;
}

/**
 * What the user is being asked to agree to. The two halves are worded per tool
 * because a load run and a cascade delete are agreed to for different reasons -
 * but the *mechanism* below is one implementation, so a fix to the elicitation
 * path reaches every gated tool.
 */
interface ConfirmationPrompt {
	/** The question, shown in the client's dialog and repeated in the preview. */
	message: string;
	/** Label of the boolean the client renders. */
	acceptTitle: string;
	acceptDescription: string;
	/** Returned when the human declines - states that nothing happened. */
	declined: string;
	/** Full text returned when the client cannot elicit and no flag was set. */
	preview: string;
}

/**
 * Ask the human before something destructive, however the client can manage it.
 *
 * Preferred path is elicitation - a real prompt to a real person. A client that
 * cannot elicit falls back to the agent-side flag: the first call returns a
 * preview and does nothing, and only a second call carrying `confirmed: true`
 * proceeds. Anti-accident rather than anti-adversary (an agent can set the flag
 * itself), which is the same posture `start_load_run` has always had; the
 * elicitation path is what upgrades it to a human decision.
 *
 * Returns `null` when the caller may proceed, or the result to return instead.
 */
async function confirmDestructive(
	args: Record<string, unknown>,
	ctx: ToolContext,
	prompt: ConfirmationPrompt
): Promise<ToolResult | null> {
	if (ctx.elicit) {
		try {
			const outcome = await ctx.elicit({
				message: prompt.message,
				requestedSchema: {
					type: "object",
					properties: {
						proceed: {
							type: "boolean",
							title: prompt.acceptTitle,
							description: prompt.acceptDescription,
						},
					},
					required: ["proceed"],
				},
			});
			if (outcome.action !== "accept" || outcome.content?.proceed === false) {
				return unchanged(textResult(prompt.declined));
			}
			return null;
		} catch {
			// Client can't elicit - fall through to the flag-based gate.
		}
	}
	if (args.confirmed !== true) return unchanged(textResult(prompt.preview));
	return null;
}

/** The `confirmed` fallback flag, declared identically on every gated tool. */
function confirmedInput(action: string) {
	return z
		.boolean()
		.optional()
		.describe(`Fallback confirmation for clients without elicitation: set true to ${action}.`);
}

/** The body modes whose content is a field list rather than a string. */
const FORM_BODY_MODES = new Set(["form-data", "x-www-form-urlencoded"]);

/**
 * The body an agent described, in the shape the engine reads.
 *
 * Both form modes carry their content as `fields` - the same
 * `{key, value, enabled}` rows the request builder and every importer produce
 * - so a `body` string is split on `&` into entries rather than handed over
 * whole. These two tools have advertised both modes all along while emitting
 * `{ mode, content }`, which the engine reads no `fields` from: before issue
 * #381 that meant an empty body on the wire, and now it is a refusal. Either
 * way the mode was documented and unusable; splitting here makes the schema's
 * promise true.
 *
 * Every field produced here is a **text** part. A `form-data` file part
 * (issue #393) names a path on the user's machine, which an agent has no way to
 * choose on their behalf and no way to verify - so MCP states the limit in the
 * two `bodyType` descriptions rather than inventing a shape for it.
 */
function bodyPayload(bodyType: string, content: string): Record<string, unknown> {
	if (!FORM_BODY_MODES.has(bodyType)) return { mode: bodyType, content };
	const fields = [...new URLSearchParams(content)].map(([key, value]) => ({
		key,
		value,
		enabled: true,
	}));
	return { mode: bodyType, fields };
}

/**
 * A whole number greater than zero, or `fallback` when the caller omitted the
 * argument.
 *
 * Rejects rather than clamps. The values this guards feed `Array.slice(-limit)`,
 * where a non-positive number does not mean "fewer rows" but *more* than asked
 * for - `0` returns everything, `-3` returns all but the three oldest - so a
 * silent repair would hand back a plausible-looking result built on an argument
 * the caller got wrong.
 */
function optionalPositiveInt(args: Record<string, unknown>, key: string, fallback: number): number {
	const v = args[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new ToolArgError(`"${key}" must be a whole number greater than 0.`);
	}
	return v;
}

/**
 * The request fields an agent stated directly, raw - and *only* the ones it
 * actually supplied, so this can be laid over a saved request by `POST
 * /compose` without a `method: "GET"` default clobbering its stored verb.
 *
 * Nothing here resolves `{{variables}}` anymore: composition - interpolation
 * and the `inherit` auth walk - is engine-owned (issue #226), and MCP hands
 * the engine raw strings. The body is emitted in the shape the engine's
 * `deserialize_request` reads - keyed off `mode`, not `type`, and carrying
 * `fields` rather than `content` for the two form modes (see `bodyPayload`).
 */
function readRequestOverrides(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	// Upper-cased because the engine's `parse_method` matches the verb exactly
	// (compose normalises this too; being explicit keeps previews readable).
	const method = str(args, "method");
	if (method !== undefined) out.method = method.toUpperCase();
	const url = str(args, "url");
	if (url !== undefined) out.url = url;
	if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
			headers[key] = String(value);
		}
		out.headers = headers;
	}
	const bodyContent = str(args, "body");
	if (bodyContent !== undefined) {
		out.body = bodyPayload(str(args, "bodyType") ?? "text", bodyContent);
	}
	// httpVersion is an override like any other field here: `POST /compose`
	// always emits a stored request's protocol, so a `start_load_run
	// { requestId, httpVersion }` must lay the agent's choice over it.
	// Forwarded only when the agent supplies one - on a URL-only call an
	// absent field already resolves to Auto engine-side. The `run_request` /
	// `start_load_run` Zod schemas restrict the value to a known protocol.
	const httpVersion = str(args, "httpVersion");
	if (httpVersion !== undefined) out.httpVersion = httpVersion;
	return out;
}

/**
 * Compose a request engine-side and return the execute-ready payload.
 *
 * This is the one place MCP's execute/load tools obtain a resolved request:
 * `POST /compose` owns `{{variable}}` interpolation and the `inherit` auth
 * walk (issue #226 deleted the MCP-side copy). Composition is pure - nothing
 * is sent - which is what lets the caller run the allowlist gate on the
 * *resolved* URL before any traffic flows, and the composed payload is passed
 * to `/execute` or `/runs` unchanged, so it is never interpolated twice.
 *
 * A 404 for a named `requestId` surfaces as a {@link ToolArgError} so the
 * agent reads "no such saved request", not a transport failure.
 */
async function composeViaEngine(
	client: EngineClient,
	body: Record<string, unknown>,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	try {
		const composed = await client.composeRequest(body, signal);
		if (!composed || typeof composed !== "object" || Array.isArray(composed)) {
			throw new ToolArgError("Engine returned an unusable composed request.");
		}
		return composed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof EngineRequestError && err.status === 404 && body.requestId) {
			throw new ToolArgError(`No saved request with id "${String(body.requestId)}".`);
		}
		throw err;
	}
}

/**
 * Start a streaming execute and read its events under the caller's bounds
 * (issue #575).
 *
 * `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and
 * hands the transfer to an engine worker, so there is no exchange to return.
 * What an agent gets instead is this: the run it can follow up on, the events
 * that arrived within the bounds it named, and - in band, beside them - which
 * bound the read stopped at.
 *
 * The three stopping conditions are reported separately rather than collapsed
 * into "partial", because the follow-up differs: `completed` means the stream
 * is over and `get_run_report` has the whole story; `capReached` means raise
 * `maxStreamEvents`; `budgetExhausted` means the stream is still running and
 * `stop_run` ends it.
 */
async function runStreamingRequest(
	args: Record<string, unknown>,
	payload: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const maxEvents = optionalPositiveInt(args, "maxStreamEvents", DEFAULT_STREAM_MAX_EVENTS);
	const budgetMs = optionalPositiveInt(args, "streamBudgetMs", DEFAULT_STREAM_BUDGET_MS);
	if (budgetMs > MAX_STREAM_BUDGET_MS) {
		return errorResult(
			`"streamBudgetMs" must be ${MAX_STREAM_BUDGET_MS} or less - a tool call cannot hold the session longer. Start the stream, then follow it with get_run_report.`
		);
	}

	let started: Record<string, unknown>;
	try {
		const accepted = await ctx.client.executeRequest(payload, signal);
		if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) {
			return errorResult("Engine returned an unusable answer for a streaming request.");
		}
		started = accepted as Record<string, unknown>;
	} catch (err) {
		return engineErrorResult(err);
	}

	const runId = typeof started.runId === "string" ? started.runId : "";
	if (!runId) {
		// A payload the engine refused *after* the flag was read, or a buffered
		// answer to a request we asked to stream. Either way, hand back what it
		// said rather than reading events for a run that does not exist.
		return jsonResult(started);
	}

	let consumed;
	try {
		consumed = await ctx.client.consumeStreamEvents(runId, maxEvents, budgetMs, signal);
	} catch (err) {
		return engineErrorResult(err);
	}

	const budgetExhausted = !consumed.completed && !consumed.capReached;
	return structuredResult({
		runId,
		eventsUrl: started.eventsUrl,
		// The bounds this read ran under, beside what it produced - not in a
		// note the agent may or may not reach.
		maxStreamEvents: maxEvents,
		streamBudgetMs: budgetMs,
		completed: consumed.completed,
		capReached: consumed.capReached,
		budgetExhausted,
		...(consumed.endReason !== undefined && { endReason: consumed.endReason }),
		...(consumed.totalEvents !== undefined && { totalEvents: consumed.totalEvents }),
		eventCount: consumed.events.length,
		events: consumed.events,
		nextStep: consumed.completed
			? "The stream has ended. get_run_report has the stored events and any test results."
			: "The run is still streaming engine-side. Read more with get_run_report, or end it with stop_run.",
	});
}

/**
 * The post-response validation script an agent supplied, under either name.
 *
 * One concept, historically two engine keys: `POST /execute` grew up calling it
 * `postRequestScript`, `POST /runs` calls it `tests`. Both endpoints now read
 * both names (`read_post_request_script`), so the choice here is purely about
 * what an agent sees: MCP names it `postRequestScript` on both tools - the way
 * the app's single **Tests** tab drives Send and a load run alike - and keeps
 * `tests` accepted as the engine's own spelling. Supplying both is rejected
 * rather than silently resolved: with no way to know which the agent meant,
 * picking one would drop a script the agent believes is running.
 *
 * Ad-hoc, so this stays a plain string (still accepted by the engine's
 * `read_script`) rather than the `ScriptPart[]` the chain-composing callers
 * send - there is no collection chain here to collect parts from.
 */
function readValidationScript(args: Record<string, unknown>): string | undefined {
	const post = str(args, "postRequestScript");
	const tests = str(args, "tests");
	if (post !== undefined && tests !== undefined) {
		throw new ToolArgError(
			'Pass either "postRequestScript" or "tests", not both - they are the same script.'
		);
	}
	return post ?? tests;
}

/** Read an optional agent-supplied `auth` block (a `{ mode, … }` object). */
function readAuthArg(args: Record<string, unknown>): AuthRecord | undefined {
	const a = args.auth;
	return a && typeof a === "object" && !Array.isArray(a) ? (a as AuthRecord) : undefined;
}

/**
 * Build the request half of a `POST /runs` body - everything except the load
 * shape (mode, duration, concurrency…).
 *
 * **Two shapes, one rule.** Given a `requestId`, `POST /compose` composes the
 * saved request exactly as the app composes it for a load run and as
 * `run_collection_smoke` composes it for a Send - variables resolved, its
 * stored auth applied through the collection chain, and the chain's + its own
 * test scripts attached. Anything the agent states explicitly - url, method,
 * headers, body, auth, tests - is laid over the stored request *before*
 * resolution, so overrides carrying `{{variables}}` resolve too. Without a
 * `requestId` the run is ad-hoc and `url` is required.
 *
 * The composed scripts stay under `postRequestScripts`: `POST /runs` reads that
 * name as an alias of `tests` (`read_post_request_script`), which is what lets
 * one composed request start either kind of run without a second shape.
 *
 * `droppedPreRequestScripts` counts what a load run cannot honour - the engine
 * has no pre-request hook on `POST /runs`, so a saved request that signs itself
 * in a pre-request script goes out unsigned under load. Counted and reported
 * rather than dropped in silence.
 */
async function composeLoadRunRequest(
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<{ payload: Record<string, unknown>; droppedPreRequestScripts: number }> {
	const savedId = str(args, "requestId");
	const overrides = readRequestOverrides(args);
	const authArg = readAuthArg(args);
	if (authArg) overrides.auth = authArg;

	const composeBody: Record<string, unknown> = {
		collectionId: str(args, "collectionId"),
		environmentId: str(args, "environmentId"),
	};
	if (savedId === undefined) {
		if (str(args, "url") === undefined) {
			throw new ToolArgError(
				'Pass "url" for an ad-hoc load run, or "requestId" to load-test a saved request.'
			);
		}
		composeBody.request = {
			...overrides,
			method: (overrides.method as string | undefined) ?? "GET",
			url: requireStr(args, "url"),
		};
	} else {
		composeBody.requestId = savedId;
		if (Object.keys(overrides).length > 0) composeBody.request = overrides;
	}

	const payload = await composeViaEngine(ctx.client, composeBody, signal);

	// A saved request's pre-request scripts cannot run under load; strip them
	// from the payload but report how many were dropped.
	const droppedPreRequestScripts = Array.isArray(payload.preRequestScripts)
		? payload.preRequestScripts.length
		: 0;
	delete payload.preRequestScripts;

	// An agent-written validation script replaces the composed one rather than
	// joining it, and must clear `postRequestScripts` to do so: /runs reads both
	// names, prefers the list, and would otherwise run the saved request's
	// assertions while silently ignoring the ones the agent asked for. This is
	// the only place either name is placed on a run payload - the handler does
	// not add it again.
	const adHocScript = readValidationScript(args);
	if (adHocScript !== undefined) {
		delete payload.postRequestScripts;
		payload.tests = adHocScript;
	}

	return { payload, droppedPreRequestScripts };
}

/**
 * Mode `start_load_run` sends when the agent names none. Closed-loop and
 * duration-bounded, so an unspecified run is one the duration cap can hold.
 */
const DEFAULT_LOAD_MODE = "constant_concurrency";

/**
 * The engine's `maxInFlight` guard (`run_config::MAX_IN_FLIGHT` in
 * `engine/include/vayu/core/constants.hpp`), mirrored here so the schema
 * rejects an out-of-range value by name instead of surfacing a 400.
 *
 * It is a literal rather than an import because production code in `electron/`
 * may not reach into `src/` - `tsconfig.node.json` withholds the `@/*` mapping
 * on purpose, so the import would not type-check. The copy is kept honest from
 * the test side, the way the dynamic-variable table already is: `tools.test.ts`
 * ties it to the renderer's `LOAD_TEST_LIMITS`, and
 * `src/constants/load-test.engine-parity.test.ts` ties that to this header.
 */
export const MAX_IN_FLIGHT_BOUND = 1_000_000;

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
 * The post-response validation script, declared identically on `run_request` and
 * `start_load_run` so one script an agent writes carries between them - the way
 * the app's single **Tests** tab drives both Send and a load run. See
 * `readValidationScript` for why the `tests` alias exists and stays.
 */
const validationScriptInput = z
	.string()
	.optional()
	.describe(
		"JavaScript run after a response arrives; use pm.test(...) for assertions, returned as test results. This is the same script the app's Tests tab holds - under load it runs against sampled responses, not every one. Read the `vayu://scripting/completions` resource for the sandbox's full surface (pm.expect chains, pm.response.to.*, the variable scopes) rather than assuming what exists."
	);

const validationScriptAliasInput = z
	.string()
	.optional()
	.describe(
		"Alias for `postRequestScript` (the engine's own name for it on a load run). Pass one or the other, not both."
	);

/**
 * How many events one budgeted read collects, and how long it may wait
 * (issue #575).
 *
 * Both bounds are the agent's to choose and both are reported back with the
 * result, because a list an agent believes is the whole stream and a list that
 * is the first `maxStreamEvents` of it lead to opposite conclusions. The
 * descriptions name the bound *before* the payload for the same reason the
 * budget-carrying tools already do: a caveat read after the data has been
 * believed is a caveat that arrived too late.
 */
const DEFAULT_STREAM_MAX_EVENTS = 50;
const DEFAULT_STREAM_BUDGET_MS = 5_000;
/** A ceiling on the ceiling: `tools/call` is request/response, and a caller
 *  that asked to wait five minutes would hold the whole MCP session. */
const MAX_STREAM_BUDGET_MS = 60_000;

/**
 * One data row bound to a single send (issue #601).
 *
 * The agent-facing half of what the app's Send-with-row does: `{{data.column}}`
 * tokens substitute against this row and both scripts read it as
 * `pm.iterationData`, without a collection run existing. `run_collection_smoke`
 * deliberately stays out of it - it has no scenario path at all (see mcp.md).
 *
 * The failure shape is named in the description because it is the useful half:
 * a column the row does not carry is a `400` naming the token and the row's
 * columns, and *nothing is sent* - so an agent reading the error can fix the
 * request rather than wondering what went out.
 *
 * Credentials bind too (issue #642), and the description says which mode does
 * not: an agent that is told "auth cannot bind" writes the token somewhere else
 * for no reason, and one told nothing writes it into an oauth2 config and gets
 * a 400 it cannot explain.
 */
const dataRowInput = z
	.record(z.unknown())
	.optional()
	.describe(
		'One data row to bind, as an object of name/value pairs (e.g. {"id": "7", "email": "a@b.c"}). Every {{data.column}} in the URL, headers, body and auth credentials is substituted against it, and pre-request and post-response scripts read it as pm.iterationData (pm.info.iteration is 0). A column the row does not carry is an error naming the token and the row\'s columns, and nothing is sent. A credential binds before it is encoded, so basic auth base64s the row\'s values; the exception is OAuth 2.0, whose token comes from the token endpoint rather than the request, so a {{data.*}} in an oauth2 config is refused by name. Omit this to send without a row, which leaves {{data.*}} tokens written as they stand.'
	);

/**
 * Whether the bound contract is a gate for a smoke run (issue #720).
 *
 * **Defaults to `true` here, where the engine's `POST /runs` flag defaults to
 * `false`**, and the divergence is deliberate rather than an oversight: this
 * tool has folded a checked-and-failed schema verdict into `ok` since #681,
 * says so in its own description, and an agent that has been reading its matrix
 * would silently start seeing contract failures pass if the default moved. The
 * flag means the same thing on both surfaces - does a schema failure fail the
 * unit - and each keeps the default its readers already have. Off, the verdict
 * still rides every row: it stops deciding `ok`, it is never withheld.
 */
const failOnSchemaErrorInput = z
	.boolean()
	.optional()
	.describe(
		"Whether a response that does not match the schema the collection's bound OpenAPI document declares fails its request (default true). Set false to report the schema verdict on each row without letting it decide pass/fail - useful against a document known to lag its API. Only a checked verdict is ever folded in: a status or content type the document declares no schema for is reported unchecked and never fails a request, with or without this."
	);

/**
 * The two fields a scenario block carries besides its collection id, declared
 * here because both scenario surfaces take them and they must mean the same
 * thing on each (issue #754): `run_collection` runs the plan once through the
 * design runner, `start_load_run` drives the same plan with virtual users.
 *
 * `iterations` is deliberately not among them - see the scenario block on
 * `start_load_run` for why a load run reads the top-level one instead.
 *
 * Whether to descend into sub-collections, and in which order that happens.
 */
const scenarioRecursiveInput = z
	.boolean()
	.optional()
	.describe(
		"Descend into sub-collections (default false). The order is the sidebar's: at every level each sub-collection's whole subtree runs before that level's own requests."
	);

/**
 * The inline data set, in the shape `POST /runs` reads it.
 *
 * Inline because the engine never opens a file - the app parses CSV/TSV/JSON and
 * sends rows, and a path an agent chose would be a trust boundary neither side
 * wants. The engine's own `maxScenarioDataRows` / `maxScenarioDataBytes` bound
 * the array and its 400 is surfaced verbatim rather than re-derived here, which
 * would be a second copy of a limit the user can raise in Settings.
 */
const scenarioDataInput = z
	.array(z.record(z.unknown()))
	.optional()
	.describe(
		'Data rows, one flat object per row (e.g. [{"id":"1"},{"id":"2"}]). Every {{data.column}} in a step\'s URL, headers, body and auth credentials is bound per iteration, and both scripts read the row as pm.iterationData. A step carrying a {{data.*}} token with no data set is refused by the engine before anything is sent, as is a present-but-empty array. Rows are never persisted - only their count is recorded on the run.'
	);

const streamInput = z
	.boolean()
	.optional()
	.describe(
		`Consume the response as a text/event-stream instead of buffering it (default false). BOUNDED, ALWAYS: this tool does not stream to you - it reads the run's events for at most \`streamBudgetMs\` milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}) and returns at most \`maxStreamEvents\` of them (default ${DEFAULT_STREAM_MAX_EVENTS}). The result says which bound it stopped at (\`completed\`, \`capReached\`, \`budgetExhausted\`) and carries \`totalEvents\` where the engine knows it, so a partial read is never mistaken for the whole stream. The run keeps going engine-side after this returns; read it later with get_run_report, or end it with stop_run.`
	);

const maxStreamEventsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how many events to return before stopping the read (default ${DEFAULT_STREAM_MAX_EVENTS}). Reaching it sets \`capReached\` - the stream itself is not stopped.`
	);

const streamBudgetMsInput = z
	.number()
	.int()
	.positive()
	.optional()
	.describe(
		`Streaming only: how long to read events for, in milliseconds (default ${DEFAULT_STREAM_BUDGET_MS}, maximum ${MAX_STREAM_BUDGET_MS}). Reaching it sets \`budgetExhausted\`.`
	);

/**
 * A saved request's stored scripts, as `create_request` and `update_request`
 * write them - the two fields the engine keeps on the row
 * (`preRequestScript` / `postRequestScript`) and the app's **Pre-request** and
 * **Tests** tabs edit.
 *
 * One name per script here, deliberately. The `tests` alias exists on the *run*
 * tools because the engine spells an ad-hoc run body that way
 * (`readValidationScript`); a second name for a stored field would be a second
 * name to keep in step and a second way for an agent to half-write a script.
 *
 * `clearable` appends the merge-patch rule, which is `update_request`'s alone -
 * on a create there is no stored script to keep.
 */
function storedScriptInput(which: "pre" | "post", clearable: boolean) {
	const what =
		which === "pre"
			? "JavaScript stored on the request and run before it is sent - the app's Pre-request tab. Use it to sign or otherwise rewrite the request through pm.request."
			: "JavaScript stored on the request and run after its response arrives - the app's Tests tab. Use pm.test(...) for assertions. Same script `run_request` takes under this name, but persisted onto the request rather than supplied per call.";
	return z
		.string()
		.optional()
		.describe(
			`${what} Read the \`vayu://scripting/completions\` resource for the sandbox's surface rather than assuming what exists.` +
				(clearable
					? " Leave it out to keep the stored script; pass an empty string to clear it."
					: "")
		);
}

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
	// Which way is an improvement. Without it a reader has to know that falling
	// latency is good and falling throughput is not; `neutral` marks the metric
	// (total requests) where neither direction is a verdict.
	direction: z.enum(["lower-is-better", "higher-is-better", "neutral"]),
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

/** Whether a `GET /health` body can be returned as `structuredContent` as-is. */
function isEngineHealthShape(value: unknown): value is Record<string, unknown> {
	return engineHealthSchema.safeParse(value).success;
}

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
			/*
			 * What the collection's bound OpenAPI document says about this
			 * response (issue #681). Absent for a collection bound to nothing -
			 * a response nobody judged against a contract did not fail one - and
			 * declared here because a field returned but not declared is
			 * rejected by the SDK before an agent ever sees it.
			 */
			schema: z
				.object({
					checked: z.boolean(),
					valid: z.boolean().optional(),
					reason: z.string().optional(),
					failuresTotal: z.number().optional(),
					failures: z.array(z.string()).optional(),
				})
				.optional(),
		})
	),
});

/**
 * The schema verdict a `POST /execute` body carries, flattened for a tool
 * result (issue #681).
 *
 * The failures are rendered `path: message` rather than passed through as
 * objects: an agent reads this as text, and the engine has already capped the
 * list. `undefined` means the engine wrote no verdict at all, which is the one
 * state that must not become `{checked: false}` - that would say the contract
 * could not judge this response, when there was no contract.
 */
function readSchemaVerdict(resp: Record<string, unknown>): Record<string, unknown> | undefined {
	const node = resp.validation;
	if (!node || typeof node !== "object") return undefined;
	const v = node as {
		checked?: unknown;
		valid?: unknown;
		reason?: unknown;
		failuresTotal?: unknown;
		failures?: unknown;
	};
	if (typeof v.checked !== "boolean") return undefined;
	const failures = Array.isArray(v.failures)
		? (v.failures as Array<{ path?: unknown; message?: unknown }>).map((f) =>
				`${typeof f.path === "string" && f.path ? f.path : "(body)"}: ${
					typeof f.message === "string" ? f.message : ""
				}`.trim()
			)
		: undefined;
	return {
		checked: v.checked,
		...(typeof v.valid === "boolean" ? { valid: v.valid } : {}),
		...(typeof v.reason === "string" ? { reason: v.reason } : {}),
		...(typeof v.failuresTotal === "number" ? { failuresTotal: v.failuresTotal } : {}),
		...(failures && failures.length > 0 ? { failures } : {}),
	};
}

const configUpdateSchema = z
	.object({
		changedKeys: z.array(z.string()),
		restartRequired: z.array(z.string()),
	})
	.passthrough();

/**
 * Of the changed config keys, which require an engine restart to take effect.
 *
 * The engine says so in a typed `requiresRestart` field on each entry
 * (`engine/src/http/routes/config.cpp`), read here and in `SettingsMain.tsx`.
 * It replaced a "… (Requires Restart)" substring in the entry's `label` that
 * both consumers regex-matched out of the prose - so a label that fell out of
 * step with the mechanism (the `workers` case, #197) misinformed an agent and
 * the settings screen at once, and no rewording of the copy could be made
 * without minding this parser.
 *
 * Strictly `=== true`: this decides whether the tool result tells an agent its
 * change is live, and a payload that omits the field (an engine older than the
 * app it is paired with) has not said that it does not need one.
 *
 * `update_config`'s `restartRequired` result shape is unchanged.
 */
function restartRequiredAmong(configResponse: unknown, changedKeys: string[]): string[] {
	const raw = Array.isArray(configResponse)
		? configResponse
		: configResponse && typeof configResponse === "object"
			? ((configResponse as Record<string, unknown>).entries ?? [])
			: [];
	const entries = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
	const byKey = new Map(entries.map((e) => [String(e.key), e]));
	return changedKeys.filter((key) => byKey.get(key)?.requiresRestart === true);
}

/**
 * The direct sub-collections of `collectionId`, by name.
 *
 * `GET /requests?collectionId=` returns a collection's *direct* requests only
 * (the DB filters on `collection_id ==`), while collections nest via `parentId`
 * - so a smoke run on a parent leaves every descendant folder untested. This
 * names them so the result can say so.
 *
 * Returns `null` when the collection list could not be read: the caller
 * discloses "could not check" rather than the absence of children, since the
 * two are not the same claim.
 */
async function childCollectionNames(
	client: EngineClient,
	collectionId: string,
	signal?: AbortSignal
): Promise<string[] | null> {
	let all: unknown;
	try {
		all = await client.listCollections(signal);
	} catch {
		return null;
	}
	if (!Array.isArray(all)) return null;
	const names: string[] = [];
	for (const item of all) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (rec.parentId === collectionId) names.push(String(rec.name ?? rec.id ?? "unnamed"));
	}
	return names;
}

/** The disclosure `run_collection_smoke` attaches about folders it did not run. */
function smokeScopeCaveat(children: string[] | null): string {
	if (children === null) {
		return (
			"\n\nNote: could not read the collection list, so any sub-collections could not be " +
			"checked. This tool runs a collection's direct requests only - requests in nested " +
			"folders are never included."
		);
	}
	if (children.length === 0) return "";
	return (
		`\n\nNote: ${children.length} sub-collection(s) were NOT run - this tool runs a ` +
		`collection's direct requests only, and the counts above exclude every request nested ` +
		`inside: ${children.join(", ")}. Call run_collection_smoke on each to cover them.`
	);
}

// --- Scenario runs (a collection as the unit of work) ------------------------

/** A step of a scenario plan, as much of it as the pre-flight walk needs. */
interface ScenarioStepRow {
	id: string;
	name: string;
}

/**
 * The saved requests a scenario run will execute, in the order the engine will
 * execute them (issue #754).
 *
 * Mirrors `collect_requests` (`engine/src/core/scenario_plan.cpp`): without
 * `recursive` a collection's direct requests are the whole plan; with it, every
 * sub-collection's subtree is emitted **before** that level's own requests, which
 * is the order the sidebar renders. The order matters here for one reason - the
 * pre-flight refusal names the first step that fails - so a walk in some other
 * order would name a different step than the run would have reached first.
 *
 * The `visited` set is the same guard the engine's walk carries: a corrupted
 * `parentId` (a self-parent, an A -> B -> A loop) must terminate rather than
 * enumerate forever.
 */
async function scenarioStepRows(
	client: EngineClient,
	collectionId: string,
	recursive: boolean,
	signal?: AbortSignal
): Promise<ScenarioStepRow[]> {
	const requestsIn = async (id: string): Promise<ScenarioStepRow[]> => {
		const rows = await client.listRequests(id, signal);
		return (Array.isArray(rows) ? rows : []).map((row) => {
			const rec = (row ?? {}) as { id?: unknown; name?: unknown };
			return {
				id: typeof rec.id === "string" ? rec.id : "",
				name: String(rec.name ?? rec.id ?? "request"),
			};
		});
	};
	if (!recursive) return requestsIn(collectionId);

	const all = await client.listCollections(signal);
	// One read, grouped by parent - `GET /collections` is ordered by `order`, so
	// each parent's children keep that order without a sort here.
	const childrenOf = new Map<string, string[]>();
	for (const item of Array.isArray(all) ? all : []) {
		if (!item || typeof item !== "object") continue;
		const rec = item as { id?: unknown; parentId?: unknown };
		if (typeof rec.id !== "string" || typeof rec.parentId !== "string" || !rec.parentId) {
			continue;
		}
		childrenOf.set(rec.parentId, [...(childrenOf.get(rec.parentId) ?? []), rec.id]);
	}

	const ordered: ScenarioStepRow[] = [];
	const visited = new Set<string>();
	// Two entry kinds on one stack, exactly as the engine walks it: `emit` is
	// pushed *under* the children, so a folder's own requests come last.
	const stack: Array<{ step: "descend" | "emit"; id: string }> = [
		{ step: "descend", id: collectionId },
	];
	while (stack.length > 0) {
		const entry = stack.pop() as { step: "descend" | "emit"; id: string };
		if (entry.step === "emit") {
			ordered.push(...(await requestsIn(entry.id)));
			continue;
		}
		if (visited.has(entry.id)) continue;
		visited.add(entry.id);
		stack.push({ step: "emit", id: entry.id });
		const children = childrenOf.get(entry.id) ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push({ step: "descend", id: children[i] });
		}
	}
	return ordered;
}

/**
 * How a step is named in a refusal: the engine's own `describe_step` wording
 * (`scenario_plan.cpp`), including its zero-based index, so a pre-flight refusal
 * and the engine's own refusal for the same step read identically.
 */
function describeScenarioStep(index: number, row: ScenarioStepRow): string {
	return `step ${index} (request '${row.name}', id '${row.id}')`;
}

/**
 * Gate every step of a scenario against the allowlist *before* the run exists,
 * and return how many steps the plan has.
 *
 * A scenario is one run: there is no per-step skip the way `run_collection_smoke`
 * has one, because the engine starts the whole sequence or none of it. So a
 * single un-allowlisted step refuses the run and **nothing is started** - the
 * alternative would be an agent generating traffic against a host it was never
 * pointed at, in the middle of a sequence it cannot stop selectively.
 *
 * Composition is the engine's, by id, with the caller's environment - the same
 * call `resolve_scenario` makes for each step, which is what makes the URL this
 * gate reads the URL the run would send to. A step that will not compose refuses
 * here too: the engine resolves the identical plan before it creates the run row
 * and would refuse it for the same reason, so failing early costs nothing and
 * says so in the same words.
 *
 * Throws {@link ToolArgError} for a refusal; engine transport failures propagate
 * to the caller's `engineErrorResult`.
 */
async function preflightScenarioSteps(
	target: { collectionId: string; recursive: boolean; environmentId?: string },
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<number> {
	const rows = await scenarioStepRows(ctx.client, target.collectionId, target.recursive, signal);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const step = describeScenarioStep(index, row);
		let composed: Record<string, unknown>;
		try {
			composed = await composeViaEngine(
				ctx.client,
				{ requestId: row.id, environmentId: target.environmentId },
				signal
			);
		} catch (err) {
			throw new ToolArgError(
				`Cannot compose ${step}: ${err instanceof Error ? err.message : String(err)}. ` +
					`Nothing was started - the engine resolves this same plan before it creates the ` +
					`run, and would refuse it for this reason too.`
			);
		}
		const url = String(composed.url ?? "");
		const gate = checkAllowlist(url, ctx.config);
		if (!gate.ok) {
			throw new ToolArgError(
				`Refusing to run this collection: ${step} sends to ${url}. ${gate.error} ` +
					`Nothing was started - a scenario runs as one sequence, so a single step the ` +
					`allowlist does not cover refuses all ${rows.length} of them.`
			);
		}
	}
	return rows.length;
}

/** The scenario block an agent passed to `start_load_run`, if it passed one. */
function readScenarioArg(
	args: Record<string, unknown>
): { collectionId: string; recursive?: boolean; data?: unknown[] } | undefined {
	const block = args.scenario;
	if (!block || typeof block !== "object" || Array.isArray(block)) return undefined;
	return block as { collectionId: string; recursive?: boolean; data?: unknown[] };
}

/**
 * `start_load_run`'s arguments that describe a *single* target, which a scenario
 * replaces wholesale, mapped to what an agent should do instead.
 *
 * Refused rather than ignored: each of these would otherwise be an argument an
 * agent believes shaped the run and that nothing on the scenario path ever reads
 * - the codebase's most-repeated defect, arriving through the front door. The
 * steps are saved requests, so their method, body, auth, protocol and scripts
 * are the stored ones, composed per step.
 */
const SINGLE_TARGET_LOAD_FIELDS: ReadonlyArray<[string, string]> = [
	["url", "a scenario's targets are the collection's saved requests"],
	["requestId", "a scenario runs a collection, not one saved request"],
	["method", "each step keeps its own stored method"],
	["headers", "each step keeps its own stored headers"],
	["body", "each step keeps its own stored body"],
	["bodyType", "each step keeps its own stored body"],
	["auth", "each step's auth is resolved from the request and its collection chain"],
	["httpVersion", "each step keeps its own stored protocol"],
	["postRequestScript", "each step runs the scripts stored on it and its collection chain"],
	["tests", "each step runs the scripts stored on it and its collection chain"],
	[
		"collectionId",
		"the collection to run is `scenario.collectionId`; this argument only scopes variable resolution for a single ad-hoc target",
	],
	["maxInFlight", "in-flight requests are bounded by the virtual-user count (`concurrency`)"],
	["sloMs", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stepDuration", "that is `capacity` mode's field, and a scenario cannot run in capacity mode"],
	["stream", "run-level stream bounds are applied to a single-target run's request only"],
	[
		"maxStreamDurationMs",
		"run-level stream bounds are applied to a single-target run's request only",
	],
	[
		"maxStreamEvents",
		"run-level stream bounds are applied to a single-target run's request only",
	],
];

/** The modes the engine will drive a scenario with (`validate_scenario_load_config`). */
const SCENARIO_LOAD_MODES = ["constant_concurrency", "ramp_up", "iterations"] as const;

/**
 * Why the engine refuses the other two modes, in its own reasoning rather than a
 * bare "unsupported": an agent told *why* `constant_rps` cannot drive a sequence
 * picks `constant_concurrency`, and one told only "no" tries again.
 */
function scenarioModeRefusal(mode: string): string | null {
	if ((SCENARIO_LOAD_MODES as readonly string[]).includes(mode)) return null;
	const shared = `Scenario load runs accept ${SCENARIO_LOAD_MODES.join(", ")}.`;
	if (mode === "capacity") {
		return (
			`"capacity" is not available for scenario runs: the search judges one windowed p99, ` +
			`and a sequence has one per step - which of them is "the" latency the knee is measured ` +
			`against is a question the mode does not answer. ${shared}`
		);
	}
	if (mode === "constant_rps") {
		return (
			`"constant_rps" is not available for scenario runs: an open-loop arrival rate over a ` +
			`multi-step sequence is an arrival-rate executor, which Vayu does not implement. ` +
			`${shared} For a scenario, "concurrency" is the number of virtual users.`
		);
	}
	return `Unknown load mode "${mode}" for a scenario run. ${shared}`;
}

/**
 * Start a scenario **load** run: the collection's plan driven by virtual users
 * (issue #754, reversing #454's deferral).
 *
 * Split from `start_load_run`'s single-target path rather than folded into it,
 * because the two share only their gates: there is no request to compose here
 * (every step composes engine-side at plan time), no url to check (the
 * pre-flight walk checks every step's), and a different set of load fields
 * applies. What they do share - the allowlist, `checkLoadCaps`, the duration
 * default under the cap, and the confirmation - runs through the same helpers,
 * so a cap raised in Settings binds both paths identically.
 */
async function startScenarioLoadRun(
	args: Record<string, unknown>,
	scenario: { collectionId: string; recursive?: boolean; data?: unknown[] },
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const inapplicable = SINGLE_TARGET_LOAD_FIELDS.filter(([key]) => args[key] !== undefined);
	if (inapplicable.length > 0) {
		return errorResult(
			`These arguments do not apply to a scenario load run: ` +
				inapplicable.map(([key, why]) => `"${key}" (${why})`).join("; ") +
				`. Nothing was started - each of them would have been read as shaping this run ` +
				`while the scenario executor never looks at it. Remove them and retry.`
		);
	}

	const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
	const modeRefusal = scenarioModeRefusal(mode);
	if (modeRefusal) return errorResult(modeRefusal);
	// The engine refuses a rate on either spelling, because either one selects
	// the open-loop path regardless of the declared mode.
	if (typeof args.targetRps === "number" && args.targetRps > 0) {
		return errorResult(
			`"targetRps" is not available for scenario runs: it selects an open-loop arrival rate, ` +
				`and a scenario run is closed-loop by design. Set "concurrency" - the number of ` +
				`virtual users - instead.`
		);
	}

	const monitor = args.monitor as { url?: unknown } | undefined;
	if (monitor && typeof monitor === "object") {
		const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config);
		if (!monitorGate.ok) return errorResult(monitorGate.error!);
	}

	const loadParams: LoadRunParams = {
		mode,
		concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
		startConcurrency:
			typeof args.startConcurrency === "number" ? args.startConcurrency : undefined,
		iterations: typeof args.iterations === "number" ? args.iterations : undefined,
		duration: (args.duration as string | number | undefined) ?? undefined,
		rampUpDuration: (args.rampUpDuration as string | number | undefined) ?? undefined,
	};
	const caps = checkLoadCaps(loadParams, ctx.config);
	if (!caps.ok) return errorResult(caps.error!);

	const environmentId = str(args, "environmentId");
	const recursive = scenario.recursive === true;
	let plannedSteps: number;
	try {
		plannedSteps = await preflightScenarioSteps(
			{ collectionId: scenario.collectionId, recursive, environmentId },
			ctx,
			signal
		);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return engineErrorResult(err);
	}

	const payload: Record<string, unknown> = {
		mode,
		scenario: scenarioBlock(scenario, recursive),
		...(environmentId !== undefined ? { environmentId } : {}),
	};
	for (const key of ["concurrency", "startConcurrency", "iterations"]) {
		if (typeof args[key] === "number") payload[key] = args[key];
	}
	for (const key of ["duration", "rampUpDuration"]) {
		const v = str(args, key);
		if (v !== undefined) payload[key] = v;
	}
	// Both travel verbatim for the same reason they do on the single-target
	// path: the keys are the engine's own and it is what judges the values.
	// Neither is executor-specific - a scenario load run is a load run, with the
	// same metrics thread, monitor scrape and end-of-run threshold evaluation.
	if (args.thresholds && typeof args.thresholds === "object")
		payload.thresholds = args.thresholds;
	if (monitor && typeof monitor === "object") payload.monitor = monitor;
	const cappedDuration = defaultDurationUnderCap(loadParams, ctx.config);
	if (cappedDuration !== null) payload.duration = cappedDuration;

	const unconfirmed = await confirmDestructive(args, ctx, {
		message:
			`Start a scenario load test over collection ${scenario.collectionId} ` +
			`(${plannedSteps} step(s) per iteration, mode: ${mode})?\n\n` +
			`This generates real traffic within Vayu's caps.`,
		acceptTitle: "Start the load test",
		acceptDescription: "Confirm to generate load now.",
		declined: "Load run not started - the user declined.",
		preview:
			"AWAITING CONFIRMATION - no run was started.\n\n" +
			"This is a preview. To start the load test, call start_load_run again with " +
			"confirmed: true and the same arguments.\n\n" +
			`Planned run (${plannedSteps} step(s) per iteration):\n${JSON.stringify(payload, null, 2)}`,
	});
	if (unconfirmed) return unconfirmed;

	return withCaveat(
		await callEngine(() => ctx.client.startRun(payload, signal)),
		`\n\nThe plan is ${plannedSteps} step(s) per iteration. Follow the run with ` +
			`get_run_report: its \`scenario\` section carries the virtual-user, iteration and ` +
			`per-step breakdown. Pre-request scripts DO run on a scenario load run - each virtual ` +
			`user walks the plan the way the design runner does.`
	);
}

/** The `scenario` block `POST /runs` reads, from the arguments an agent gave. */
function scenarioBlock(
	scenario: { collectionId: string; data?: unknown[] },
	recursive: boolean,
	iterations?: number
): Record<string, unknown> {
	return {
		source: "collection",
		collectionId: scenario.collectionId,
		recursive,
		// Omitted rather than defaulted: with `data` present and this absent the
		// engine sets the pass count to the row count, and a client computing
		// its own would be a second copy of a rule only one side enforces.
		...(iterations !== undefined ? { iterations } : {}),
		...(scenario.data !== undefined ? { data: scenario.data } : {}),
	};
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

// --- Cascade accounting for delete_collection --------------------------------

/** A `GET /collections` row, narrowed to the fields the cascade walk reads. */
interface CollectionRow {
	id: string;
	name?: string;
	parentId?: string | null;
}

/** The collections list, dropping anything without a usable id. */
function readCollectionRows(value: unknown): CollectionRow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is CollectionRow =>
			!!row && typeof row === "object" && typeof (row as CollectionRow).id === "string"
	);
}

/**
 * Every collection a cascade delete of `rootId` destroys, root first - itself
 * plus every descendant, since collections nest through `parentId` and
 * `DELETE /collections/:id` takes the whole subtree with it.
 *
 * Null when `rootId` is not in the list: the caller must say "no such
 * collection" rather than ask the user to confirm destroying nothing. The
 * `seen` set is what stops a malformed parent cycle from looping forever - the
 * engine rejects cycles on write, but this walk reads whatever is stored.
 */
function collectionSubtree(rows: CollectionRow[], rootId: string): string[] | null {
	if (!rows.some((row) => row.id === rootId)) return null;
	const childrenOf = new Map<string, string[]>();
	for (const row of rows) {
		const parent = typeof row.parentId === "string" ? row.parentId : "";
		if (!parent) continue;
		childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row.id]);
	}
	const seen = new Set<string>([rootId]);
	const ordered: string[] = [rootId];
	for (let i = 0; i < ordered.length; i++) {
		for (const child of childrenOf.get(ordered[i]) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			ordered.push(child);
		}
	}
	return ordered;
}

/** What a cascade delete is about to destroy, read before the user is asked. */
interface CascadeScope {
	name: string;
	/** Descendants only - the collection itself is not counted among them. */
	descendants: number;
	requests: number;
}

/**
 * Read the subtree `collectionId` roots and count what goes with it.
 *
 * Every count here is read from the engine rather than assumed, because it is
 * the number the user agrees to: a prompt that guessed would be asking consent
 * for something other than what happens. A failed read therefore throws instead
 * of degrading to "0 requests" - `ToolArgError` for a collection that does not
 * exist, the transport error otherwise, and either way nothing is deleted.
 */
async function readCascadeScope(
	client: EngineClient,
	collectionId: string,
	signal?: AbortSignal
): Promise<CascadeScope> {
	const rows = readCollectionRows(await client.listCollections(signal));
	const subtree = collectionSubtree(rows, collectionId);
	if (subtree === null) throw new ToolArgError(`No collection with id "${collectionId}".`);
	const lists = await Promise.all(subtree.map((id) => client.listRequests(id, signal)));
	const requests = lists.reduce<number>(
		(total, list) => total + (Array.isArray(list) ? list.length : 0),
		0
	);
	const root = rows.find((row) => row.id === collectionId);
	return {
		name: typeof root?.name === "string" && root.name !== "" ? root.name : collectionId,
		descendants: subtree.length - 1,
		requests,
	};
}

/** One sentence naming everything a cascade delete destroys. */
function describeCascade(scope: CascadeScope): string {
	return (
		`Deleting "${scope.name}" also destroys ${scope.descendants} sub-collection(s) and ` +
		`${scope.requests} saved request(s) inside it. This cannot be undone.`
	);
}

// --- Mock issuer -------------------------------------------------------------

/**
 * The fields `POST /mock-issuer/start` accepts, in the engine's spelling
 * (`parse_mock_issuer_settings`, engine/src/http/routes/mock_issuer.cpp). One
 * list rather than a hand-written object literal per field, so the payload
 * builder and the tool's input schema cannot drift apart.
 */
const MOCK_ISSUER_START_KEYS = [
	"port",
	"expiresInSeconds",
	"claims",
	"clients",
	"failureMode",
	"slowMs",
	"issueRefreshTokens",
] as const;

/** The failure modes the issuer's `/token` endpoint can be put into. */
const MOCK_ISSUER_FAILURE_MODES = ["none", "slow", "server_error", "invalid_client"] as const;

/**
 * The start body, carrying only the fields the caller actually named - an
 * absent one must stay absent, because the engine reads a present field with a
 * bad type or an out-of-range value as an error rather than falling back to the
 * default, and `undefined` would serialize to `null`.
 *
 * The engine's *limits* (the 31-day expiry ceiling, the 60s slow ceiling, 32
 * clients, 8 concurrent issuers) are deliberately not restated in the schema:
 * they live in `core/constants.hpp`, an out-of-range value comes back as a
 * `400 mock_issuer_invalid_config` naming the bound, and a second copy here
 * would be a second thing to keep in step - one that refuses values the engine
 * accepts the moment either side moves. What the schema does own is the shape:
 * a claims object, an integer port, a failure mode from the closed set above.
 */
function mockIssuerStartPayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of MOCK_ISSUER_START_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	return payload;
}

// --- Tool definitions --------------------------------------------------------

export const TOOLS: McpTool[] = [
	{
		name: "get_engine_health",
		category: "read",
		invalidates: [],
		description:
			"Check the Vayu engine's status and version. Use this first to confirm Vayu is running.",
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
				// Anything the outputSchema would reject is wrapped instead of
				// returned bare. A declared outputSchema makes the SDK reject a
				// non-error result whose `structuredContent` does not validate (and
				// one with none at all), and that rejection surfaces as "Tool
				// get_engine_health has an output schema but no structured content
				// was provided" - blaming the schema and swallowing the body an
				// operator needs to see. A mid-restart engine answering 200 with a
				// bare string or a `status`-less object is exactly when it matters.
				return isEngineHealthShape(value)
					? structuredResult(value)
					: structuredResult({ status: "unknown", raw: value ?? null });
			} catch (err) {
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "list_collections",
		category: "read",
		invalidates: [],
		description: "List all request collections (folders that organize saved requests).",
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
		invalidates: [],
		description: "List the saved requests inside a collection.",
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
		invalidates: [],
		description: "List all environments (named sets of variables like baseUrl, apiKey).",
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
		invalidates: [],
		description:
			"List recent past runs (both single Design-mode requests and load tests), " +
			"newest first. Returns a {data, pagination} envelope bounded to the first " +
			"100 runs; each row carries a compact summary (url/method/mode/duration/" +
			"concurrency/comment), not the full config snapshot.",
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
		invalidates: [],
		description:
			"Get the full report for a completed run: summary, latency percentiles (p50/p95/p99), status codes, errors, and timing breakdown. Ideal input for analyzing performance. " +
			"A run of a collection bound to an OpenAPI document also carries `coverage`: which of the contract's operations the run exercised, which of their declared responses it saw, and any statuses the document never declared. Absent - never zeros - for a run that was not measured against a contract.",
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
		invalidates: [],
		description:
			"Get the engine's tunable configuration entries (workers, timeouts, connection limits, buffer sizes, etc.), each with its current value, default, type, and allowed range.",
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
		invalidates: ["run", "cookie"],
		description:
			"Send a single HTTP request through Vayu (Design mode) and return the response, timing, and any test results. The target host must be on Vayu's MCP allowlist. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given, using the same precedence as the app (environment > collection chain > globals). Pass an `auth` block to have the engine apply bearer/basic/apikey/oauth2 auth. Pass a `preRequestScript` to sign or otherwise rewrite the request before it goes out - its pm.request edits are applied to what is actually sent. (To replay a saved request with its stored auth and scripts across a whole collection, use run_collection_smoke.)",
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
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. File parts are not supported. For graphql, a bare query document is enveloped as `{"query": ...}` and sent as application/json; an envelope you write yourself is sent unchanged. For jsonrpc, a bare call object gains `"jsonrpc":"2.0"` - plus `"id":1` when it names no id - and is sent as application/json; a frame already declaring a string `"jsonrpc"` is sent byte for byte, so write the frame yourself to choose your own id or to send a notification (no id). A top-level array is a batch call and is sent unchanged. An xml `body` is sent byte for byte as application/xml; a Content-Type you set yourself wins.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate: "auto" | "http1.1" | "http2" (default "auto"). Mirrors the request builder\'s Settings tab picker.'
				),
			requestId: z.string().optional().describe("Optional saved request ID to link."),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			data: dataRowInput,
			preRequestScript: z
				.string()
				.optional()
				.describe(
					"JavaScript run before the request is sent. It may edit pm.request.url / .method / .headers / .body, and those edits are what gets sent - a script-set header overrides the engine-applied auth. The sandbox is synchronous and has no network: to sign a request use pm.crypto.sha256 / pm.crypto.hmacSha256 and the btoa / atob globals. Read the `vayu://scripting/completions` resource for the full surface."
				),
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			stream: streamInput,
			maxStreamEvents: maxStreamEventsInput,
			streamBudgetMs: streamBudgetMsInput,
		},
		handler: async (args, ctx, signal) => {
			const request: Record<string, unknown> = {
				...readRequestOverrides(args),
				url: requireStr(args, "url"),
			};
			if (request.method === undefined) request.method = "GET";
			// `/execute`'s own key names for the two ad-hoc scripts. Scripts ride
			// through composition untouched - the engine never interpolates them.
			const preScript = str(args, "preRequestScript");
			if (preScript !== undefined) request.preRequestScript = preScript;
			const postScript = readValidationScript(args);
			if (postScript !== undefined) request.postRequestScript = postScript;
			const authArg = readAuthArg(args);
			if (authArg) request.auth = authArg;

			// Compose engine-side (pure), gate on the *resolved* URL, then execute
			// the composed payload unchanged - resolved exactly once.
			let payload: Record<string, unknown>;
			try {
				payload = await composeViaEngine(
					ctx.client,
					{
						request,
						collectionId: str(args, "collectionId"),
						environmentId: str(args, "environmentId"),
					},
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const gate = checkAllowlist(String(payload.url ?? ""), ctx.config);
			if (!gate.ok) return errorResult(gate.error!);
			// `requestId` here only links the run to a saved request for History;
			// it must not reach /compose, which would compose the *stored* row
			// instead of the arguments the agent actually gave.
			const linkId = str(args, "requestId");
			if (linkId !== undefined) payload.requestId = linkId;

			// Beside the composed payload, not through composition: `{{data.*}}`
			// survives `/compose` by design (`request_composer.hpp`), so the
			// tokens are still written when `/execute` binds them against this
			// row (issue #601). Absent means today's send, unchanged.
			const dataRow = args.data;
			if (dataRow !== undefined && dataRow !== null) payload.data = dataRow;

			// Stated on every call, never elided: the two answers have different
			// *shapes* - `202 {runId, eventsUrl}` against the exchange - so a
			// caller that let composition or an engine default decide would not
			// know which one it was about to parse. The same rule both app
			// clients follow for `followRedirects`.
			const streaming = args.stream === true;
			payload.stream = streaming;
			if (!streaming) {
				return callEngine(() => ctx.client.executeRequest(payload, signal));
			}
			return runStreamingRequest(args, payload, ctx, signal);
		},
	},
	{
		name: "update_engine_config",
		category: "write",
		invalidates: ["config"],
		description:
			"Update one or more engine configuration entries. GUARDED: requires write access to be enabled in Vayu Settings. Pass `entries` as a map of config key to new value; the engine validates types/ranges and rejects the whole batch on any invalid value. Some keys require an engine RESTART to take effect - the result lists those under `restartRequired`; they are saved but the running engine keeps the old value until the user restarts it (Vayu Settings → restart engine, or relaunch).",
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
		name: "create_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Create a collection (the folder saved requests live in). GUARDED: requires write access to be enabled in Vayu Settings. Pass `parentId` to nest it inside an existing collection; omit it for a top-level one. Returns the created collection - its `id` is what create_request takes as `collectionId`.",
		annotations: {
			title: "Create collection",
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			name: z.string().describe("Display name for the collection."),
			parentId: z
				.string()
				.optional()
				.describe("Optional parent collection ID; omit for a top-level collection."),
			description: z.string().optional(),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload: Record<string, unknown> = { name: requireStr(args, "name") };
			const parentId = str(args, "parentId");
			if (parentId !== undefined) payload.parentId = parentId;
			const description = str(args, "description");
			if (description !== undefined) payload.description = description;
			return callEngine(() => ctx.client.createCollection(payload, signal));
		},
	},
	{
		name: "update_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Rename or re-describe a collection. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change - everything else the collection holds (its variables, auth, scripts, and the requests inside it) is left alone. This is not a move: re-parenting a collection is a reorder operation and is not exposed here.",
		annotations: {
			title: "Update collection",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to update."),
			name: z.string().optional().describe("New display name."),
			description: z.string().optional().describe("New description."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// The engine merge-patches, so a body naming nothing would be a write
			// that changes nothing while reporting success. Say so instead.
			const payload: Record<string, unknown> = {};
			for (const field of ["name", "description"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			if (Object.keys(payload).length === 0) {
				return errorResult('Pass at least one of "name" or "description" to change.');
			}
			return callEngine(() => ctx.client.updateCollection(collectionId, payload, signal));
		},
	},
	{
		name: "delete_collection",
		category: "write",
		invalidates: ["collection"],
		description:
			"Delete a collection AND EVERYTHING INSIDE IT - every nested sub-collection and every saved request in them. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the number of sub-collections and requests this destroys; otherwise call once to see those counts, then again with `confirmed: true`. There is no undo.",
		annotations: {
			title: "Delete collection",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection ID to delete, with its whole subtree."),
			confirmed: confirmedInput("actually delete the collection and its contents"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			// Read what the cascade takes before asking: an unreadable subtree is a
			// refusal, never a prompt carrying counts nobody verified.
			let scope: CascadeScope;
			try {
				scope = await readCascadeScope(ctx.client, collectionId, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const cascade = describeCascade(scope);
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the collection "${scope.name}"?\n\n${cascade}`,
				acceptTitle: "Delete the collection",
				acceptDescription: "Confirm to delete it and everything inside it.",
				declined: "Collection not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`${cascade}\n\n` +
					"This is a preview. To delete it, call delete_collection again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			const result = await callEngine(() =>
				ctx.client.deleteCollection(collectionId, signal)
			);
			// The counts describe what was destroyed, so they belong only on a
			// delete that happened - a refusal wearing them would read as one.
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nDeleted "${scope.name}" with ${scope.descendants} sub-collection(s) and ${scope.requests} saved request(s).`
					);
		},
	},
	{
		name: "create_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Create a saved request inside a collection (stores it; does not send it), optionally with its pre-request and test scripts. GUARDED: requires write access to be enabled in Vayu Settings. The URL may contain {{variables}} since it is only saved, not executed, and a stored script runs only when the request is later sent.",
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
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. File parts are not supported here - a multipart file part names a path on the user\'s machine, which an agent cannot choose for them; author it in the app. An xml `body` is stored and sent verbatim as application/xml.'
				),
			description: z.string().optional(),
			preRequestScript: storedScriptInput("pre", false),
			postRequestScript: storedScriptInput("post", false),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
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
				payload.body = bodyPayload(bodyType, body);
				payload.bodyType = bodyType;
			}
			// Pass-through strings: absent leaves the engine's own default (empty),
			// so only what the caller actually named is sent.
			for (const field of ["description", "preRequestScript", "postRequestScript"] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			return callEngine(() => ctx.client.createRequest(payload, signal));
		},
	},
	{
		name: "update_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Correct a saved request: its name, URL, method, headers, body, description or pre/post-request scripts. GUARDED: requires write access to be enabled in Vayu Settings. Only the fields you pass change - anything you leave out keeps its stored value, including the request's auth. Passing `headers` replaces the whole header list, so send every header the request should end up with; passing a script replaces that script, and an empty string clears it.",
		annotations: {
			title: "Update saved request",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to update."),
			name: z.string().optional().describe("New display name."),
			url: z.string().optional().describe("New URL (may contain {{variables}})."),
			method: z.string().optional().describe("New HTTP method."),
			headers: z
				.record(z.string())
				.optional()
				.describe("Replacement headers as a string map (replaces the stored list)."),
			body: z.string().optional().describe("New request body content."),
			bodyType: z
				.string()
				.optional()
				.describe(
					"Body type for `body`: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded. Only meaningful alongside `body`. A jsonrpc `body` is enveloped engine-side exactly as `create_request` describes; an xml `body` is stored and sent verbatim as application/xml. File parts are not supported here; a stored one is left alone unless `body` replaces the whole body."
				),
			description: z.string().optional().describe("New description."),
			preRequestScript: storedScriptInput("pre", true),
			postRequestScript: storedScriptInput("post", true),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			/*
			 * The payload carries exactly what the caller named: `PUT /requests/:id`
			 * is a merge-patch (absent keeps, null resets), so a field omitted here
			 * is a field left alone. That is also why nothing is defaulted - a
			 * `method: "GET"` filler would silently rewrite the stored verb.
			 */
			const payload: Record<string, unknown> = {};
			for (const field of [
				"name",
				"url",
				"method",
				"description",
				// An empty string is a value here, not an omission: the engine's
				// merge-patch stores it, which is how a script gets cleared.
				"preRequestScript",
				"postRequestScript",
			] as const) {
				const value = str(args, field);
				if (value !== undefined) payload[field] = value;
			}
			if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
				payload.headers = toKeyValueEntries(args.headers);
			}
			const body = str(args, "body");
			const bodyType = str(args, "bodyType");
			if (body !== undefined) {
				// Both keys move together, the way create_request writes them: the
				// blob is what round-trips in the app, `bodyType` the denormalized
				// column beside it. Writing one without the other leaves the two
				// disagreeing about what the request sends.
				payload.body = bodyPayload(bodyType ?? "text", body);
				payload.bodyType = bodyType ?? "text";
			} else if (bodyType !== undefined) {
				return errorResult(
					'"bodyType" describes "body" - pass the body it applies to, or leave both out.'
				);
			}
			if (Object.keys(payload).length === 0) {
				return errorResult(
					"Pass at least one field to change (name, url, method, headers, body, description, preRequestScript or postRequestScript)."
				);
			}
			return callEngine(() => ctx.client.updateRequest(requestId, payload, signal));
		},
	},
	{
		name: "delete_request",
		category: "write",
		invalidates: ["request"],
		description:
			"Delete a saved request. GUARDED: requires write access to be enabled in Vayu Settings, and confirmation: if the client supports elicitation the user is prompted with the request's name and URL; otherwise call once for a preview, then again with `confirmed: true`. There is no undo.",
		annotations: {
			title: "Delete saved request",
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			requestId: z.string().describe("Saved request ID to delete."),
			confirmed: confirmedInput("actually delete the request"),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const requestId = requireStr(args, "requestId");
			// Read it first so the person answering the prompt sees what is about to
			// go, rather than an id. A 404 here is the answer, not a failure to ask.
			let stored: Record<string, unknown>;
			try {
				const value = await ctx.client.getRequest(requestId, signal);
				stored =
					value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			} catch (err) {
				if (err instanceof EngineRequestError && err.status === 404) {
					return errorResult(`No saved request with id "${requestId}".`);
				}
				return engineErrorResult(err);
			}
			const name =
				typeof stored.name === "string" && stored.name !== "" ? stored.name : requestId;
			const target = [stored.method, stored.url]
				.filter((v) => typeof v === "string")
				.join(" ");
			const subject = target ? `"${name}" (${target})` : `"${name}"`;
			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `Delete the saved request ${subject}?\n\nThis cannot be undone.`,
				acceptTitle: "Delete the request",
				acceptDescription: "Confirm to delete this saved request.",
				declined: "Request not deleted - the user declined.",
				preview:
					"AWAITING CONFIRMATION - nothing was deleted.\n\n" +
					`This would delete the saved request ${subject}. This cannot be undone.\n\n` +
					"This is a preview. To delete it, call delete_request again with confirmed: true and the same arguments.",
			});
			if (unconfirmed) return unconfirmed;
			return callEngine(() => ctx.client.deleteRequest(requestId, signal));
		},
	},
	{
		name: "update_environment",
		category: "write",
		invalidates: ["environment"],
		description:
			"Set or overwrite variables on an environment (merges with the existing variables - other variables are preserved). GUARDED: requires write access to be enabled in Vayu Settings.",
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
			const refused = writesDisabled(ctx);
			if (refused) return refused;
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
				// Overwrite the *value*, not the entry: `secret`, `type` and
				// `createdAt` are the user's own settings (a secret rotated here
				// must stay masked in the popover), and nothing else restores
				// them - the engine replaces the blob wholesale. The object guard
				// keeps a malformed stored entry (a bare string, an array) from
				// spreading into index-keyed garbage; the renderer treats those
				// as a real case (`lib/variable-resolution.ts`, D17), so they are
				// replaced with a sane entry rather than merged onto.
				const prev = mergedVars[key];
				const base =
					prev && typeof prev === "object" && !Array.isArray(prev)
						? (prev as Record<string, unknown>)
						: {};
				// `enabled` leads the spread so a new (or malformed) entry defaults
				// to enabled while an existing explicit flag survives - writing a
				// value must not silently re-enable a variable the user disabled.
				// The tool returns the updated environment, so a caller who wrote
				// to a disabled variable sees `enabled: false` in the result.
				mergedVars[key] = { enabled: true, ...base, value: String(value) };
			}
			// PUT carries the id in the path, so the body is the patch only. The
			// name is still sent because the engine treats it as having no
			// default - omitting it would keep the stored name, but sending the
			// caller's rename in the same call is the point of the `name` arg.
			const payload: Record<string, unknown> = {
				name: str(args, "name") ?? (typeof existing.name === "string" ? existing.name : ""),
				variables: mergedVars,
			};
			return callEngine(() => ctx.client.updateEnvironment(environmentId, payload, signal));
		},
	},
	{
		name: "run_collection_smoke",
		category: "execute",
		invalidates: ["run", "cookie"],
		description:
			"Execute a collection's own saved requests once each and return a pass/fail matrix (a request passes on a 2xx/3xx status with all its tests passing and, when the collection is bound to an OpenAPI document, a response matching the schema that document declares - a response the document declares no schema for is reported as unchecked and never fails the request; pass failOnSchemaError: false to keep that verdict on every row without letting it decide pass/fail). Scope is the collection's DIRECT requests: nested sub-collections are not run, and the result discloses how many were left out - call this tool on each of them to cover them. Requests run one at a time, so a large collection takes as long as its requests do added together. Each request is composed exactly as the app would send it: {{variables}} resolved (environment > collection chain > globals), the request's stored auth applied (inheriting from the collection chain, incl. OAuth2), and its collection-chain + own pre/post scripts run. Each request's resolved host must be on the allowlist; requests whose host still cannot be verified (e.g. a variable did not resolve and allow-all is off) are skipped. Sends real traffic but does not modify Vayu data.",
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
			failOnSchemaError: failOnSchemaErrorInput,
		},
		outputSchema: smokeResultSchema,
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			// Absent means the gate stays on - this tool's behaviour since #681.
			// Read once, before any traffic: it decides how every row is judged,
			// and a per-row read of one argument could only ever be wrong twice.
			const failOnSchemaError = args.failOnSchemaError !== false;
			let requests: unknown;
			try {
				requests = await ctx.client.listRequests(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			const list = Array.isArray(requests) ? requests : [];
			// Read before any traffic flows: after the loop this call competes with
			// a cancellation the run itself may have raised, and the disclosure has
			// to survive that.
			const children = await childCollectionNames(ctx.client, collectionId, signal);
			const results: Array<Record<string, unknown>> = [];
			let passed = 0;
			let failed = 0;
			let skipped = 0;

			for (const item of list) {
				const req = (item ?? {}) as {
					id?: string;
					name?: string;
					method?: string;
					url?: string;
				};
				const name = String(req.name ?? req.id ?? "request");
				// Compose the request the same way the app's Send does - engine-side
				// (`POST /compose`): variables resolved, stored/inherited auth
				// applied, and the chain's + its own scripts attached.
				let outgoing: Record<string, unknown>;
				try {
					outgoing = await composeViaEngine(
						ctx.client,
						{ requestId: String(req.id ?? ""), environmentId },
						signal
					);
				} catch (err) {
					results.push({
						name,
						method: String(req.method ?? "GET"),
						url: String(req.url ?? ""),
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					});
					failed++;
					continue;
				}
				const method = String(outgoing.method ?? "GET");
				const url = String(outgoing.url ?? "");

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
					// The contract's own verdict, folded in the way `testResults`
					// folds (issue #681): a response the document declares a
					// schema for and that does not match it is a failed request.
					// Only a *checked* verdict can fail one - `checked: false`
					// says the response could not be judged, which is not the
					// same as judged and wrong, and failing a smoke run on it
					// would make an undocumented status look like a broken API.
					//
					// `failOnSchemaError: false` unfolds it (issue #720): the
					// verdict still rides the row, it just stops deciding `ok`.
					const schema = readSchemaVerdict(resp);
					const schemaOk =
						!failOnSchemaError || !(schema?.checked === true && schema.valid === false);
					const ok = code >= 200 && code < 400 && testsOk && schemaOk;
					results.push({
						name,
						method,
						url,
						ok,
						statusCode: code,
						...(schema ? { schema } : {}),
					});
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

			return withCaveat(
				structuredResult({
					collectionId,
					total: list.length,
					passed,
					failed,
					skipped,
					results,
				}),
				smokeScopeCaveat(children)
			);
		},
	},
	{
		name: "run_collection",
		category: "execute",
		invalidates: ["run", "cookie"],
		description:
			"Run a collection as the product means collections to be run: its saved requests executed as an ordered sequence, one step at a time, by the engine's design-mode runner. Unlike run_collection_smoke this is ONE run with a run id - steps share a cookie jar, `pm.execution` flow control (setNextRequest, skipRequest) works, pre-request scripts run, and passing `data` repeats the sequence once per row with {{data.column}} bound and pm.iterationData set. Pass recursive: true to include sub-collections, in the sidebar's order. The collection tree IS the sequence: there is no step list to give. Every step's resolved host must be on the allowlist - unlike the smoke matrix, which skips an off-allowlist request and runs the rest, a scenario is one run, so a single step the allowlist does not cover refuses the whole run and nothing is sent. Returns the run id immediately; the run continues engine-side and get_run_report reads its outcome. Sends real traffic but does not modify Vayu data. For a load test over the same sequence, use start_load_run's `scenario` argument.",
		annotations: {
			title: "Run collection",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection whose requests make up the sequence."),
			environmentId: z
				.string()
				.optional()
				.describe(
					"Environment whose variables resolve {{templates}} in every step, and whose cookie jar the run uses."
				),
			recursive: scenarioRecursiveInput,
			// Positive: the engine reads the count as a pass total, so a zero is a
			// run with nothing to do and a negative is not a count at all. Named
			// rather than clamped, like every other count in this registry.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"How many passes over the sequence (default 1, or the row count when `data` is given). With more passes than rows the row index wraps."
				),
			data: scenarioDataInput,
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const environmentId = str(args, "environmentId");
			const recursive = args.recursive === true;
			const iterations = typeof args.iterations === "number" ? args.iterations : undefined;
			const data = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;

			let plannedSteps: number;
			try {
				plannedSteps = await preflightScenarioSteps(
					{ collectionId, recursive, environmentId },
					ctx,
					signal
				);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}

			const payload: Record<string, unknown> = {
				scenario: scenarioBlock({ collectionId, data }, recursive, iterations),
				...(environmentId !== undefined ? { environmentId } : {}),
			};

			let started: unknown;
			try {
				started = await ctx.client.startRun(payload, signal);
			} catch (err) {
				return engineErrorResult(err);
			}
			// The engine's 202 body is the answer; anything else is handed back as
			// it came rather than dressed up as a started run.
			if (!started || typeof started !== "object" || Array.isArray(started)) {
				return jsonResult(started);
			}
			return structuredResult({
				...(started as Record<string, unknown>),
				plannedSteps,
				nextStep:
					`The run executes engine-side. Read it with get_run_report(runId): the ` +
					`\`scenario\` section carries the iteration and pass/fail/skip totals plus ` +
					`\`stepsStored\`/\`stepsDropped\`, and \`results\` returns at most 100 step rows ` +
					`(non-passing steps are kept first). Each row's \`trace\` carries that step's ` +
					`request and response bodies inline, so a long plan against large responses ` +
					`makes for a large report - read the totals first and the rows when you need ` +
					`them. stop_run ends the run early.`,
			});
		},
	},
	{
		name: "start_load_run",
		category: "load",
		invalidates: ["run"],
		description:
			"Start a load test against a URL, or against a saved request via `requestId` - which composes it exactly as the app does, including the collection chain's and its own test scripts, so a load run checks the same assertions a Send does. GUARDED: the host must be on the allowlist, and RPS/concurrency/duration must be within Vayu's caps. {{variables}} in the URL, headers, and body are resolved when an environmentId (and/or collectionId) is given; pass an `auth` block to authenticate the load (bearer/basic/apikey/oauth2, applied engine-side). Pass a `postRequestScript` - the same assertions you would give run_request - to validate responses under load; it runs against sampled responses. A pre-request script is not offered here for a single target: the engine runs one on a single request only, never on a load run. Pass `scenario` INSTEAD of url/requestId to load-test a collection's ordered sequence: `concurrency` then means virtual users, each walking the plan with its own cookies and running every step's stored scripts, and only constant_concurrency, ramp_up and iterations can drive it. Confirmation is required: if the client supports elicitation the user is prompted directly; otherwise call once for a preview, then again with `confirmed: true`.",
		annotations: {
			title: "Start load test",
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			method: z.string().optional(),
			url: z
				.string()
				.optional()
				.describe(
					"Target URL (may contain {{variables}}). Required unless `requestId` names a saved request to load-test; supplying both retargets that request at this URL."
				),
			headers: z.record(z.string()).optional(),
			body: z.string().optional().describe("Request body content."),
			// The two sibling tools have carried this text since they existed and
			// this one carried nothing, so an agent load-testing a GraphQL endpoint
			// had no way to discover the mode from the schema.
			bodyType: z
				.string()
				.optional()
				.describe(
					'Body type: json, text, graphql, jsonrpc, xml, form-data, x-www-form-urlencoded (default text). For the two form types, write `body` as `key=value&key=value`; it is split into form fields. A jsonrpc `body` may be the bare call object - the engine adds `"jsonrpc":"2.0"` and `"id":1` when it names no id, and sends a frame that already declares a string `"jsonrpc"` unchanged. File parts are not supported here - a multipart file part names a path on the user\'s machine, which an agent cannot choose for them; author it in the app. An xml `body` is stored and sent verbatim as application/xml.'
				),
			auth: authInput,
			httpVersion: z
				.enum(HTTP_VERSIONS)
				.optional()
				.describe(
					'Protocol to negotiate for this ad-hoc run: "auto" | "http1.1" | "http2" (default "auto"). There is no saved request behind this call, so this is how the protocol gets specified at all - not an override of a per-run setting.'
				),
			mode: z
				.string()
				.optional()
				.describe("constant_rps | constant_concurrency | ramp_up | iterations | capacity."),
			// Positive, because an agent's natural guess for "unlimited" is -1 or
			// 0, and the engine reads concurrency as an eager per-worker
			// pre-allocation count. It rejects those with a 400; failing here
			// names the field instead of surfacing an HTTP error.
			concurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Target in-flight requests."),
			// Positive for the same reason `concurrency` is: the ramp is seeded
			// with this count, so a negative casts to ~1.8e19 engine-side and a
			// zero start is a ramp that begins with no traffic at all.
			startConcurrency: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Ramp start concurrency (ramp_up). Above `concurrency` ramps down."),
			duration: z
				.string()
				.optional()
				.describe(
					'Duration with an optional ms/s/m/h unit, e.g. "500ms", "30s", "5m", "2h"; a bare number is seconds (non-iterations modes).'
				),
			rampUpDuration: z
				.string()
				.optional()
				.describe("Ramp time (ramp_up), same units as `duration`."),
			// Capacity discovery reuses `startConcurrency` (where the search
			// begins), `concurrency` (the ceiling it will not climb past) and
			// `duration` (the whole search's deadline), so it adds only these
			// two. The `sloMs` bound is the engine's, so a value this schema
			// accepts is one POST /runs accepts.
			sloMs: z
				.number()
				.positive()
				.max(60_000)
				.optional()
				.describe("p99 budget the capacity search looks for the edge of, in ms."),
			stepDuration: z
				.string()
				.optional()
				.describe(
					"How long each concurrency level is held before it is judged (capacity), same units as `duration`."
				),
			// An iterations run stops on this count and reads no duration, so it
			// is the only thing bounding the run; `-1` would cast to ~1.8e19.
			iterations: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Iteration count (iterations mode)."),
			targetRps: z.number().optional().describe("Target RPS (constant_rps)."),
			// Streaming under load (issue #576). Forwarded verbatim and bounded
			// only by the engine's own `constants::sse` ranges, on the
			// thresholds precedent: the engine validates before the run row
			// exists, so a value this schema accepts is one `POST /runs`
			// accepts, and re-deriving the rule here would be a second copy to
			// keep in step. The caps are refused there without `stream`, which
			// is what keeps an unbounded run from being mistaken for a capped
			// one - so this schema does not quietly drop them either.
			stream: z
				.boolean()
				.optional()
				.describe(
					"Consume each response as a text/event-stream. Under load a stream is bounded by construction: reaching a cap below completes it successfully rather than failing it."
				),
			maxStreamDurationMs: z
				.number()
				.int()
				.min(1000)
				.max(86_400_000)
				.optional()
				.describe(
					"Wall-clock cap on one stream, in ms (requires `stream`). Defaults to the engine's sseMaxStreamDurationMs."
				),
			maxStreamEvents: z
				.number()
				.int()
				.min(1)
				.max(10_000_000)
				.optional()
				.describe(
					"Event cap on one stream (requires `stream`). Defaults to the engine's sseMaxStreamEvents."
				),
			// A pending-request ceiling read as a `size_t`, so `-1` - the natural
			// "unlimited" spelling - removes the ceiling instead of tightening it.
			// The upper bound is the engine's, so a value this schema accepts is
			// one `POST /runs` accepts.
			maxInFlight: z
				.number()
				.int()
				.positive()
				.max(MAX_IN_FLIGHT_BOUND)
				.optional()
				.describe(
					`In-flight cap (constant_rps only), 1-${MAX_IN_FLIGHT_BOUND}. Default max(targetRps * 10, 1000).`
				),
			// Pass/fail budgets for the whole run. The bounds mirror the
			// engine's, so a value this schema accepts is one POST /runs
			// accepts; an empty object is rejected there rather than starting a
			// run nothing will judge, so it is rejected here too, by name.
			thresholds: z
				.object({
					latencyP50Ms: z.number().positive().max(86_400_000).optional(),
					latencyP95Ms: z.number().positive().max(86_400_000).optional(),
					latencyP99Ms: z.number().positive().max(86_400_000).optional(),
					maxErrorRatePct: z.number().min(0).max(100).optional(),
					minThroughputRps: z.number().positive().max(1_000_000_000).optional(),
				})
				.refine((t) => Object.keys(t).length > 0, {
					message: "Declare at least one budget, or omit `thresholds` entirely.",
				})
				.optional()
				.describe(
					"Pass/fail budgets for this run. The report comes back with `thresholdValidation`: one check per budget plus a verdict of passed/failed. Omit for a run that is measured but not judged."
				),
			// Shaped exactly as the engine's `monitor` block and forwarded
			// verbatim. The value bounds are deliberately not mirrored here the
			// way `thresholds`' are: `monitor.series`' ceiling is the
			// `monitorMaxSeries` **setting**, so a second copy in this schema
			// would refuse blocks the engine accepts as soon as the user raises
			// it - and `validate_run_config` already answers each one by field
			// name. This layer types the shape; the engine owns the ranges.
			monitor: z
				.object({
					url: z
						.string()
						.describe(
							"http(s) URL of a Prometheus /metrics or flat-JSON endpoint on the target. A loopback or private-network URL needs no allowlist entry; a public one is checked against the allowlist like the target URL is."
						),
					intervalMs: z
						.number()
						.optional()
						.describe(
							"Scrape cadence in ms, 250-60000 (default: the engine's setting)."
						),
					format: z
						.enum(["prometheus", "json"])
						.optional()
						.describe(
							'Body format: "prometheus" text exposition, or "json" (a flat object of numbers). Default "prometheus".'
						),
					series: z
						.array(z.string())
						.describe(
							'Metric names to read out of each scrape, e.g. ["process_cpu_seconds_total"]. At least one; the ceiling is the `monitorMaxSeries` setting (8 by default).'
						),
				})
				.optional()
				.describe(
					"Scrape the target's own metrics endpoint for the life of the run, so its CPU or memory can be read on the same timeline as p99 and throughput. The report comes back with a `monitor` section: per-series min/max/avg plus the sample and failed-scrape counts. Omit for a run that measures only the client side."
				),
			requestId: z
				.string()
				.optional()
				.describe(
					"Load-test a saved request. It is composed the way the app composes it: {{variables}} resolved, its stored auth applied (inheriting through the collection chain), and its collection-chain + own test scripts run against sampled responses. Any field you also pass explicitly (url, method, headers, body, auth, tests) overrides the saved one. Omit this and `url` is required, for an ad-hoc run."
				),
			environmentId: environmentIdInput,
			collectionId: collectionIdInput,
			postRequestScript: validationScriptInput,
			tests: validationScriptAliasInput,
			// The other shape POST /runs accepts (issue #754). Mutually exclusive
			// with every single-target argument, which the handler refuses by name
			// rather than ignoring - see SINGLE_TARGET_LOAD_FIELDS.
			//
			// No `iterations` inside the block, unlike the design-mode runner's:
			// a load run reads the *top-level* `iterations` (`scenario_load.cpp`
			// takes it from the run config), and `scenario.iterations` is the
			// design runner's per-run pass count, which this executor never looks
			// at. Offering it here would be an argument written and never read.
			scenario: z
				.object({
					collectionId: z
						.string()
						.describe("Collection whose saved requests are the sequence."),
					recursive: scenarioRecursiveInput,
					data: scenarioDataInput,
				})
				.optional()
				.describe(
					"Load-test a collection's ordered sequence instead of one target. Cannot be combined with url/requestId or any single-target field. `concurrency` is the number of virtual users, each walking the whole plan with its own cookies; `iterations` (top level) is the total passes across all of them in iterations mode. Modes: constant_concurrency (default), ramp_up, iterations - constant_rps and capacity are refused, with the engine's reasoning."
				),
			confirmed: confirmedInput("actually start the run"),
		},
		handler: async (args, ctx, signal) => {
			// A scenario replaces the single target wholesale - there is nothing to
			// compose here, so the branch comes before composition rather than
			// inside it.
			const scenario = readScenarioArg(args);
			if (scenario) return startScenarioLoadRun(args, scenario, ctx, signal);

			let composed;
			try {
				composed = await composeLoadRunRequest(args, ctx, signal);
			} catch (err) {
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
			const url = String(composed.payload.url ?? "");
			if (!url) {
				return errorResult(
					`Saved request "${str(args, "requestId")}" has no URL to load-test.`
				);
			}
			const gate = checkAllowlist(url, ctx.config);
			if (!gate.ok) return errorResult(gate.error!);

			// A monitored run contacts a second host, so it gets a second gate.
			// The scrape needs no duration cap of its own: the monitor thread is
			// joined when the run ends, so whatever bounds the run bounds it.
			const monitor = args.monitor as { url?: unknown } | undefined;
			if (monitor && typeof monitor === "object") {
				const monitorGate = checkMonitorHost(String(monitor.url ?? ""), ctx.config);
				if (!monitorGate.ok) return errorResult(monitorGate.error!);
			}

			// One mode string for both the guard and the payload: which strategy
			// the engine picks decides which cap applies, so a guard reading a
			// different mode than the run uses is a guard reading the wrong run.
			const mode = str(args, "mode") ?? DEFAULT_LOAD_MODE;
			const loadParams: LoadRunParams = {
				mode,
				targetRps: typeof args.targetRps === "number" ? args.targetRps : undefined,
				concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
				startConcurrency:
					typeof args.startConcurrency === "number" ? args.startConcurrency : undefined,
				iterations: typeof args.iterations === "number" ? args.iterations : undefined,
				duration: (args.duration as string | number | undefined) ?? undefined,
				rampUpDuration: (args.rampUpDuration as string | number | undefined) ?? undefined,
				stepDuration: (args.stepDuration as string | number | undefined) ?? undefined,
			};
			const caps = checkLoadCaps(loadParams, ctx.config);
			if (!caps.ok) return errorResult(caps.error!);

			const payload: Record<string, unknown> = {
				...composed.payload,
				mode,
			};
			for (const key of [
				"concurrency",
				"startConcurrency",
				"iterations",
				"targetRps",
				"maxInFlight",
				"sloMs",
				"maxStreamDurationMs",
				"maxStreamEvents",
			]) {
				if (typeof args[key] === "number") payload[key] = args[key];
			}
			// Forwarded only when present: the engine refuses a cap on a
			// non-streaming run, and refuses `stream` beside `transient`, so a
			// defaulted `false` here would turn "the caller said nothing" into
			// a claim the engine then has to judge (issue #576).
			if (typeof args.stream === "boolean") payload.stream = args.stream;
			for (const key of ["duration", "rampUpDuration", "stepDuration"]) {
				const v = str(args, key);
				if (v !== undefined) payload[key] = v;
			}
			// Forwarded verbatim - the keys are the engine's own metric names,
			// and they come back unchanged in `get_run_report`'s
			// `thresholdValidation`. Zod has already bounded every value.
			if (args.thresholds && typeof args.thresholds === "object") {
				payload.thresholds = args.thresholds;
			}
			// Same posture as `thresholds`: the keys are the engine's own and
			// `validate_run_config` is what judges the values, so the block
			// travels unchanged rather than being rebuilt field by field here.
			if (monitor && typeof monitor === "object") {
				payload.monitor = monitor;
			}
			// An omitted duration is 60s engine-side, not "unbounded" and not
			// "capped" - so a cap under 60s has to be sent as an explicit field
			// or it never reaches the run.
			const cappedDuration = defaultDurationUnderCap(loadParams, ctx.config);
			if (cappedDuration !== null) payload.duration = cappedDuration;

			// A saved request's pre-request script cannot run under load - the
			// engine has no such hook on POST /runs. Say so rather than let an agent
			// believe the request was prepared the way a Send prepares it.
			const caveat =
				composed.droppedPreRequestScripts > 0
					? `\n\nNote: ${composed.droppedPreRequestScripts} pre-request script(s) on this saved request were NOT applied - POST /runs has no pre-request hook, so anything they sign or rewrite is missing from the requests this run sends.`
					: "";

			const summary = `Start a load test against ${payload.url} (mode: ${payload.mode})?`;

			const unconfirmed = await confirmDestructive(args, ctx, {
				message: `${summary}\n\nThis generates real traffic within Vayu's caps.`,
				acceptTitle: "Start the load test",
				acceptDescription: "Confirm to generate load now.",
				declined: "Load run not started - the user declined.",
				preview:
					"AWAITING CONFIRMATION - no run was started.\n\n" +
					"This is a preview. To start the load test, call start_load_run again with confirmed: true and the same arguments.\n\n" +
					`Planned run:\n${JSON.stringify(payload, null, 2)}${caveat}`,
			});
			if (unconfirmed) return unconfirmed;

			return withCaveat(await callEngine(() => ctx.client.startRun(payload, signal)), caveat);
		},
	},
	{
		name: "stop_run",
		category: "load",
		invalidates: ["run"],
		description: "Stop an in-progress load test.",
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
		invalidates: [],
		description:
			"Get a snapshot of the most recent live metrics ticks for a run (RPS, latency percentiles, error rate, status mix). Returns the last N ticks; does not stream.",
		annotations: {
			title: "Get live metrics",
			readOnlyHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			runId: z.string().describe("Run ID to sample."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("How many recent ticks to return (default 10). Must be 1 or more."),
		},
		handler: (args, ctx, signal) => {
			const runId = requireStr(args, "runId");
			// Guarded here as well as in the schema: the SDK validates arguments
			// before dispatch, but the handler is the layer that knows a
			// non-positive limit reaches `slice(-limit)` and inverts the bound.
			const limit = optionalPositiveInt(args, "limit", 10);
			return callEngine(() =>
				ctx.client.getLiveMetricsSnapshot(runId, limit, undefined, signal)
			);
		},
	},
	{
		name: "compare_runs",
		category: "read",
		invalidates: [],
		description:
			"Compare two completed runs and return the deltas in latency percentiles, throughput, error rate, and status-code mix, each labelled with which direction is an improvement. Use to answer 'did this change regress performance?'. Omit baseRunId to compare against the run pinned as the baseline for the same saved request.",
		annotations: {
			title: "Compare runs",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			baseRunId: z
				.string()
				.optional()
				.describe(
					"Baseline run ID (e.g. main). Omit to use the run pinned as baseline for the target's saved request."
				),
			targetRunId: z.string().describe("Comparison run ID (e.g. the change)."),
		},
		outputSchema: runComparisonSchema,
		handler: async (args, ctx, signal) => {
			const targetRunId = requireStr(args, "targetRunId");
			try {
				const baseRunId =
					str(args, "baseRunId") || (await resolveBaseline(targetRunId, ctx, signal));
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
				// A baseline that could not be resolved is an argument problem the
				// caller can fix, not an engine failure - it must not be reported
				// as one.
				if (err instanceof ToolArgError) return errorResult(err.message);
				return engineErrorResult(err);
			}
		},
	},
	{
		name: "start_mock_issuer",
		category: "execute",
		// Nothing in the renderer reads issuers today (`rg -i issuer app/src` is
		// empty), so there is no entity to invalidate: an `McpDataEntity` with no
		// reader is the written-never-read defect that field exists to prevent.
		// #502 adds the Services drawer that lists them - when it lands, an
		// "issuer" entity belongs here and on its query.
		invalidates: [],
		description:
			"Start a local OAuth 2.0 mock issuer and return its id, token URL, authorize URL and signing key. Use it to test an auth flow offline: start an issuer, point a request's oauth2 auth at the returned tokenUrl, run it with run_request, and assert on what the target received - no real identity provider, so no 2FA prompts, provider rate limits or account lockouts in the loop. It needs no allowlist entry: the engine binds every issuer to 127.0.0.1 and takes no host for it, so it is unreachable off this machine. The access token is an HS256 JWT signed with the returned signingKey - hand that key to the service under test and it can verify the mock's tokens. Set a short expiresInSeconds (with issueRefreshTokens) to exercise the 401-then-refresh path, and failureMode to exercise retry handling. At most 8 issuers run at once; stop yours with stop_mock_issuer when you are done.",
		annotations: {
			title: "Start mock OAuth issuer",
			readOnlyHint: false,
			// It binds a loopback listener and mints tokens for it: it destroys no
			// saved data and reaches nothing off the machine.
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			port: z
				.number()
				.int()
				.min(0)
				.max(65535)
				.optional()
				.describe("Port to bind on 127.0.0.1. Default 0 - the engine picks a free one."),
			expiresInSeconds: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Lifetime of a minted access token, in seconds (default 3600). Set it low to make a token expire mid-test."
				),
			claims: z
				.record(z.unknown())
				.optional()
				.describe(
					'Extra JWT claims, e.g. {"sub": "alice", "roles": ["admin"]}. iss, iat, exp and jti are always the issuer\'s own; sub, client_id and scope are filled in only when you do not set them.'
				),
			clients: z
				.array(
					z.object({
						clientId: z.string().min(1).describe("Client id this issuer accepts."),
						clientSecret: z
							.string()
							.optional()
							.describe("Secret that client must then present."),
					})
				)
				.optional()
				.describe(
					"Clients the issuer accepts. Omit (the default) to accept any client id."
				),
			failureMode: z
				.enum(MOCK_ISSUER_FAILURE_MODES)
				.optional()
				.describe(
					'How /token misbehaves: "none" (default), "slow" (answers after slowMs), "server_error" (500), "invalid_client" (401).'
				),
			slowMs: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe('Delay before /token answers, in milliseconds. Only "slow" reads it.'),
			issueRefreshTokens: z
				.boolean()
				.optional()
				.describe(
					"Return a refresh_token alongside the access token, so a refresh grant can be tested. A refresh rotates its token - the presented one is spent."
				),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.startMockIssuer(mockIssuerStartPayload(args), signal)),
	},
	{
		name: "list_mock_issuers",
		category: "read",
		invalidates: [],
		description:
			"List the OAuth 2.0 mock issuers running right now, each with its id, urls, signing key, port, token expiry, failure mode and configured client count. Use it to find an issuer started earlier in the session, or to confirm one was stopped.",
		annotations: {
			title: "List mock OAuth issuers",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) => callEngine(() => ctx.client.listMockIssuers(signal)),
	},
	{
		name: "stop_mock_issuer",
		category: "execute",
		// See start_mock_issuer - no renderer reader yet, #502 adds one.
		invalidates: [],
		description:
			"Stop a running OAuth 2.0 mock issuer and free its port. Tokens it already minted stay valid until they expire - nothing verifies them against the issuer once it is gone. An unknown id is an error, not a silent success.",
		annotations: {
			title: "Stop mock OAuth issuer",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			issuerId: z.string().describe("Issuer ID to stop (from start_mock_issuer)."),
		},
		handler: (args, ctx, signal) =>
			callEngine(() => ctx.client.stopMockIssuer(requireStr(args, "issuerId"), signal)),
	},
];

/** Look up a tool by name. Only `dispatchTool` needs this, so it stays local. */
function findTool(name: string): McpTool | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** IPC-safe metadata for every tool, for the Settings tool list. */
export function toolCatalog(): McpToolInfo[] {
	return TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		category: t.category,
	}));
}

/**
 * Dispatch a `tools/call`. Converts argument errors into tool errors so the
 * agent gets a readable message instead of a protocol failure.
 *
 * The single dispatch path: `server.ts` routes every registered tool callback
 * through here, so the disabled-tool rejection below is the same code the tests
 * exercise. (The SDK validates arguments against the Zod `inputSchema` first,
 * and registration already skips disabled tools - this rejection is what
 * answers a client that calls one anyway.)
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
	let result: ToolResult;
	try {
		result = await tool.handler(args, ctx, signal);
	} catch (err) {
		if (err instanceof ToolArgError) return errorResult(err.message);
		return errorResult(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Only a call that succeeded changed anything. A tool that returned an error
	// result may still have got as far as the engine, but it cannot say so, and
	// an invalidation storm on every rejected call would be worse than the one
	// stale list a genuinely-partial failure leaves behind. A confirmation
	// preview is the third case: successful, and deliberately without effect.
	if (!result.isError && !NOTHING_CHANGED.has(result)) notifyDataChanged(tool, args, ctx);
	return result;
}

/**
 * Tell the renderer what a successful call changed, one event per declared
 * entity. The scope hints come from the call's own arguments: every tool in the
 * registry spells these two the same way, so reading them here is what keeps a
 * new write tool from having to remember an emit of its own.
 *
 * Notification failure must not fail a write the engine has already applied -
 * the same rule `update_engine_config`'s best-effort read-back follows - so a
 * throwing listener is logged and swallowed rather than turned into a tool
 * error the agent would read as "the write did not happen".
 */
function notifyDataChanged(tool: McpTool, args: Record<string, unknown>, ctx: ToolContext): void {
	if (!ctx.onDataChanged || tool.invalidates.length === 0) return;
	const collectionId = str(args, "collectionId");
	const requestId = str(args, "requestId");
	for (const entity of tool.invalidates) {
		try {
			ctx.onDataChanged({
				entity,
				...(collectionId !== undefined ? { collectionId } : {}),
				...(requestId !== undefined ? { requestId } : {}),
			});
		} catch (err) {
			console.error(`[MCP] Failed to notify "${entity}" change from ${tool.name}:`, err);
		}
	}
}
