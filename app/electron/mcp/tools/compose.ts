/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief The request an execute or load tool sends: argument overrides,
 *        engine-side composition, the streaming read, the agent-script gate and
 *        the load-run payload with its bounds.
 */

import type { McpSafetyConfig } from "../config.js";
import { type EngineClient, EngineRequestError } from "../engine-client.js";
import {
	ENGINE_LOAD_DEFAULTS,
	engineLoadMode,
	exemptMonitorHost,
	type LoadDefaultsTable,
	type LoadMode,
	type LoadRunParams,
	parseDurationSeconds,
} from "../safety.js";
import { runOutputShape, withheldAuthMembers } from "../withhold.js";
import type { ToolContext, ToolResult } from "./contract.js";
import {
	engineErrorResult,
	errorResult,
	isRecord,
	num,
	optionalPositiveInt,
	requireStr,
	str,
	structuredResult,
	structuredRoot,
	ToolArgError,
} from "./kit.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { boundExecuteResponse } from "./inline-body-bounds.js";
import { bodyPayload, INLINE_FILE_REFUSAL } from "./request-body.js";
import { selectEnvironment } from "./variable-blobs.js";
import { REVEAL_SETTING_TOKEN, settingRemedy } from "../remedy.js";
import {
	READ_WITHHELD_REASON,
	refuseRedactedAuth,
	refuseRedactedHeaders,
	refuseRedactedUrl,
} from "./redacted-input.js";

/**
 * The `headers` an agent passed: ordered `[{ name, value }]` lines, a repeated name sent once per
 * line in order (issue #2466), or the single-valued `{ name: value }` map, one line per key. Both
 * go to `POST /compose` as given; it answers lines either way. A line that is not an object with a
 * string `name` is refused here by name rather than forwarded for the engine to refuse without
 * saying which one.
 */
function readHeaderOverrides(
	raw: unknown
): Record<string, string> | Array<{ name: string; value: string }> | undefined {
	if (Array.isArray(raw)) {
		return raw.map((line, index) => {
			if (!isRecord(line) || typeof line.name !== "string") {
				throw new ToolArgError(
					`headers[${index}] must be an object with a string "name" and a "value".`
				);
			}
			return { name: line.name, value: String(line.value) };
		});
	}
	if (!raw || typeof raw !== "object") return undefined;
	return Object.fromEntries(
		Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, String(value)])
	);
}

/** The override lines as the `{key, value}` rows the credential rules judge. */
function overrideRows(
	headers: NonNullable<ReturnType<typeof readHeaderOverrides>>
): { key: string; value: string }[] {
	const lines = Array.isArray(headers)
		? headers
		: Object.entries(headers).map(([name, value]) => ({ name, value }));
	return lines.map((line) => ({ key: line.name, value: line.value }));
}

/**
 * The request fields an agent stated directly, raw and *only* those it supplied, so `POST /compose`
 * can lay this over a saved request without a `method: "GET"` default clobbering its stored verb.
 * Nothing here resolves `{{variables}}`: composition (interpolation, the `inherit` auth walk) is
 * engine-owned (issue #226) and MCP hands the engine raw strings. The body is emitted in the shape
 * the engine's `deserialize_request` reads: keyed off `mode`, not `type`, with `fields` rather than
 * `content` for the two form modes (see `bodyPayload`).
 */
export function readRequestOverrides(
	args: Record<string, unknown>,
	ctx: ToolContext
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	// Upper-cased because the engine's `parse_method` matches the verb exactly
	// (compose normalises this too; being explicit keeps previews readable).
	const method = str(args, "method");
	if (method !== undefined) out.method = method.toUpperCase();
	const url = str(args, "url");
	if (url !== undefined) {
		refuseRedactedUrl(ctx, url, args.auth);
		out.url = url;
	}
	const headers = readHeaderOverrides(args.headers);
	if (headers !== undefined) {
		refuseRedactedHeaders(ctx, overrideRows(headers), args.auth);
		out.headers = headers;
	}
	// Before anything is composed: an inline body is never a file, because
	// nothing here can stand for the person who has to choose it.
	if (str(args, "bodyType") === "binary" || args.file !== undefined) {
		throw new ToolArgError(INLINE_FILE_REFUSAL, "policy");
	}
	const bodyContent = str(args, "body");
	if (bodyContent !== undefined) {
		out.body = bodyPayload(str(args, "bodyType") ?? "text", bodyContent);
	}
	// httpVersion is an override like any other field: `POST /compose` always emits a stored
	// request's protocol, so a `start_load_run { requestId, httpVersion }` must lay the agent's
	// choice over it. Forwarded only when supplied (an absent field on a URL-only call already
	// resolves to Auto engine-side); the `run_request` / `start_load_run` Zod schemas restrict the
	// value to a known protocol.
	const httpVersion = str(args, "httpVersion");
	if (httpVersion !== undefined) out.httpVersion = httpVersion;
	// Redirect policy is part of the request half, not the load shape: the app sends both fields
	// through `POST /compose` beside the method and body (`request-builder/index.tsx`), and the
	// engine emits them on every composed payload (never elided). Only `start_load_run` declares
	// them (`run_request` has no such argument), because an ad-hoc load target has no saved request
	// whose stored policy the run could inherit.
	if (typeof args.followRedirects === "boolean") out.followRedirects = args.followRedirects;
	if (typeof args.maxRedirects === "number") out.maxRedirects = args.maxRedirects;
	return out;
}

/**
 * The payload as `POST /execute` / `POST /runs` receives it from this server: marked as an
 * MCP-started run, naming the handshake's client when known (#1817), and carrying the session's
 * allowlist as `targetPolicy`, which the engine applies to the URL it is about to send, after any
 * pre-request script (#2521). The gate here judges the composed URL; a script can still move it,
 * and only the engine sees where it moved.
 *
 * Applied at the send, after every argument is folded in, so nothing a caller passes can claim
 * another origin or a wider policy; the one entry beyond the allowlist is the exempt monitor host
 * `mcpTargetPolicy` adds from the run's `monitor` block. The client name goes as sent; the engine
 * trims and caps it. Every `executeRequest` / `startRun` call in this server goes through here,
 * which `tools.dispatch.test.ts` checks by scanning for one that does not.
 */
export function asMcpSend(
	payload: Record<string, unknown>,
	ctx: ToolContext
): Record<string, unknown> {
	const client = ctx.clientName?.();
	// The composed answer's list of deferred names is for the agent that asked
	// to compose; the send has no use for it.
	const { deferredVariables: _deferredVariables, ...sendable } = payload;
	return {
		...sendable,
		origin: client === undefined ? { kind: "mcp" } : { kind: "mcp", client },
		targetPolicy: mcpTargetPolicy(sendable.monitor, ctx.config),
	};
}

/**
 * The session's allowlist as the engine reads it, plus the host of a run's @p monitor block when
 * `checkMonitorHost` exempts it: the engine judges `monitor.url` against this policy too (#3121),
 * with no exemption of its own. The entry also admits the run's own requests to that host if a
 * pre-request script steers them there; the gate on each composed target still refuses the host
 * before the run starts.
 */
function mcpTargetPolicy(
	monitor: unknown,
	config: McpSafetyConfig
): { allowAll: boolean; allowedHosts: string[] } {
	const allowedHosts = [...config.allowlist];
	const monitorHost = config.allowAll ? undefined : exemptMonitorHost(monitor);
	if (monitorHost !== undefined) allowedHosts.push(monitorHost);
	return { allowAll: config.allowAll, allowedHosts };
}

/**
 * Compose a request engine-side and return the execute-ready payload.
 *
 * This is the one place MCP's execute/load tools obtain a resolved request: `POST /compose` owns
 * `{{variable}}` interpolation and the `inherit` auth walk (issue #226 deleted the MCP-side copy).
 * Composition is pure, so the caller can run the allowlist gate on the *resolved* URL before any
 * traffic flows, and the composed payload goes to `/execute` or `/runs` unchanged: a substituted
 * value is never substituted again. What the engine still resolves is the leftovers: a name
 * composition could not answer keeps its braces (#1009) and is resolved after the pre-request
 * script, before the send (#1008), which is why the gate refuses an unresolved *authority* rather
 * than checking one.
 *
 * A 404 for a named `requestId` surfaces as a {@link ToolArgError}, so the agent reads "no such
 * saved request", not a transport failure.
 */
export async function composeViaEngine(
	client: EngineClient,
	body: Record<string, unknown>,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	try {
		const composed = await client.composeRequest(body, signal);
		if (!composed || typeof composed !== "object" || Array.isArray(composed)) {
			throw new ToolArgError("Engine returned an unusable composed request.", "transient");
		}
		return composed as Record<string, unknown>;
	} catch (err) {
		if (err instanceof EngineRequestError && err.status === 404 && body.requestId) {
			throw new ToolArgError(
				unknownIdText(ID_KINDS.request, String(body.requestId)),
				"not_found"
			);
		}
		throw err;
	}
}

/**
 * The `environmentId` a send composes with: the active environment when the call names none,
 * nothing for `"none"`, and a {@link ToolArgError} for an id no environment has (#2480).
 * `POST /compose` degrades an unknown id to an empty scope, so without this a mistyped id would
 * send every environment token literally with nothing naming the cause. Call it once per tool call,
 * before any compose: resolving per step would turn one bad argument into one failure per step.
 */
export async function resolveEnvironmentId(
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<string | undefined> {
	const row = await selectEnvironment(ctx, str(args, "environmentId"), signal);
	return typeof row?.id === "string" ? row.id : undefined;
}

/**
 * How many events one budgeted read collects, and how long it may wait (issue #575). Both bounds
 * are the agent's to choose and both are reported back with the result, because a list an agent
 * believes is the whole stream and one that is only the first `maxStreamEvents` of it lead to
 * opposite conclusions. The descriptions name the bound *before* the payload, as the
 * budget-carrying tools already do: a caveat read after the data has been believed arrived too
 * late.
 */
export const DEFAULT_STREAM_MAX_EVENTS = 50;
export const DEFAULT_STREAM_BUDGET_MS = 5_000;
/** A ceiling on the ceiling: `tools/call` is request/response, and a caller
 *  that asked to wait five minutes would hold the whole MCP session. */
export const MAX_STREAM_BUDGET_MS = 60_000;

/**
 * Set the stream flag on a composed payload. A `streamTextPath` and `streamFirstContentMarker` ride
 * only beside `stream: true` (the engine refuses either on a buffered send, #3773, #3774), and a
 * by-id compose carries the saved request's, so forcing the flag off drops both with it.
 */
export function setStreamFlag(payload: Record<string, unknown>, stream: boolean): void {
	payload.stream = stream;
	if (stream) return;
	delete payload.streamTextPath;
	delete payload.streamFirstContentMarker;
}

/** The reply the request's stream text path read: each event's `text`, in order, joined with nothing between. */
function joinedEventText(events: ReadonlyArray<Record<string, unknown>>): string {
	return events.map((event) => (typeof event.text === "string" ? event.text : "")).join("");
}

/**
 * Start a streaming execute and read its events under the caller's bounds (issue #575).
 * `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and hands the transfer to an
 * engine worker, so there is no exchange to return: an agent gets the run to follow up on, the
 * events that arrived within its bounds, and, in band beside them, which bound the read stopped at.
 *
 * The three stopping conditions are reported separately rather than collapsed into "partial",
 * because the follow-up differs: `completed` means the stream is over and `get_run_report` has the
 * whole story; `capReached` means raise `maxStreamEvents`; `budgetExhausted` means the stream is
 * still running and `stop_run` ends it.
 */
export async function runStreamingRequest(
	args: Record<string, unknown>,
	payload: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<ToolResult> {
	const maxEvents = optionalPositiveInt(args, "maxStreamEvents", DEFAULT_STREAM_MAX_EVENTS);
	const budgetMs = optionalPositiveInt(args, "streamBudgetMs", DEFAULT_STREAM_BUDGET_MS);
	if (budgetMs > MAX_STREAM_BUDGET_MS) {
		return errorResult(
			`"streamBudgetMs" must be ${MAX_STREAM_BUDGET_MS} or less - a tool call cannot hold the session longer. Start the stream, then follow it with get_run and read it with get_run_report.`,
			"input"
		);
	}

	let started: Record<string, unknown>;
	try {
		const accepted = await ctx.client.executeRequest(asMcpSend(payload, ctx), signal);
		if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) {
			return errorResult(
				"Engine returned an unusable answer for a streaming request.",
				"transient"
			);
		}
		started = accepted as Record<string, unknown>;
	} catch (err) {
		return engineErrorResult(err, ctx);
	}

	const runId = typeof started.runId === "string" ? started.runId : "";
	if (!runId) {
		// A payload the engine refused *after* the flag was read, or a buffered
		// answer to a request we asked to stream. Either way, hand back what it
		// said rather than reading events for a run that does not exist.
		const withhold = await runOutputShape(ctx, signal, [payload.auth]);
		// Masked first, then bounded, as the buffered path does: a buffered answer
		// can carry a body of any size.
		return structuredResult(structuredRoot(boundExecuteResponse(withhold(started))));
	}

	let consumed;
	try {
		consumed = await ctx.client.consumeStreamEvents(runId, maxEvents, budgetMs, signal);
	} catch (err) {
		return engineErrorResult(err, ctx);
	}

	const withhold = await runOutputShape(ctx, signal, [payload.auth]);
	const budgetExhausted = !consumed.completed && !consumed.capReached;
	// Declared by the request, not inferred from the events: a path that read
	// nothing yet is an empty reply, and no path is no `text` at all.
	const declaresText = typeof payload.streamTextPath === "string";
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
		...(declaresText && { text: withhold(joinedEventText(consumed.events)) }),
		...(args.events !== false && { events: withhold(consumed.events) }),
		nextStep: consumed.completed
			? "The stream has ended. get_run_report has the stored events and any test results."
			: "The run is still streaming engine-side. get_run says whether it is done and get_run_report reads the events stored so far; end it with stop_run.",
	});
}

/**
 * The post-response validation script an agent supplied, under either name. One concept, two engine
 * keys: `POST /execute` calls it `postRequestScript` and `POST /runs` calls it `tests`. The
 * endpoints have since diverged (`/execute` takes `elements` and refuses both old spellings, issue
 * #1514; `/runs` still reads `tests`), so this returns the script as a plain string and each caller
 * spells it as its endpoint wants. MCP names it `postRequestScript` on both tools, as the app's
 * single **Tests** tab drives Send and a load run alike, and keeps `tests` accepted as the engine's
 * own spelling on the run tools. Supplying both is rejected: with no way to know which the agent
 * meant, picking one would drop a script the agent believes is running.
 */
export function readValidationScript(args: Record<string, unknown>): string | undefined {
	const post = str(args, "postRequestScript");
	const tests = str(args, "tests");
	if (post !== undefined && tests !== undefined) {
		throw new ToolArgError(
			'Pass either "postRequestScript" or "tests", not both - they are the same script.'
		);
	}
	return post ?? tests;
}

/**
 * The element kinds the engine compiles into a script runner
 * (`engine/src/core/elements/script_kinds.cpp`). `script.setup` and
 * `script.teardown` are not a phase this surface writes, but an `elements`
 * entry of either kind runs the same sandbox, so the refusal covers all four.
 */
const SCRIPT_KINDS: ReadonlySet<string> = new Set([
	"script.pre",
	"script.post",
	"script.setup",
	"script.teardown",
]);

/**
 * Whitespace-only, by the engine's own definition (`is_blank_script_text`):
 * such a script is inert there, composed nowhere and compiled to nothing, so
 * refusing it would turn away a call that grants no capability.
 */
const BLANK_SCRIPT = /^[ \t\r\n]*$/;

/**
 * An `elements` entry that would run script text. The kind is folded and trimmed although the
 * engine matches it exactly (`Registry::find`): a refusal tracking the engine's current spelling
 * would be one normalising change away from a bypass, and a variant the engine rejects is refused
 * here for the right reason anyway.
 */
function carriesScript(entry: unknown): boolean {
	if (!isRecord(entry) || typeof entry.kind !== "string") return false;
	if (!SCRIPT_KINDS.has(entry.kind.trim().toLowerCase())) return false;
	const script = isRecord(entry.config) ? entry.config.script : undefined;
	return script !== undefined && !(typeof script === "string" && BLANK_SCRIPT.test(script));
}

/**
 * What a send or load tool says about the scripts it takes, for the
 * description of each: an agent that reads only the parameter would otherwise
 * meet the refusal as a surprise. @p carriers names what counts as a script on
 * that tool.
 */
export function agentScriptGateSentence(carriers: string): string {
	return `Unless the user has chosen to ${REVEAL_SETTING_TOKEN}, a script you supply here (${carriers}) is refused before anything is sent, because a script reads every variable, secret ones included; a blank script is not refused.`;
}

/**
 * Refuse a script the agent wrote while Reveal secrets to agents is off (#1834). A script runs in a
 * sandbox that reads every variable the request resolves against, secret ones included, and can
 * write one into a test result, a variable or the request it sends, so an agent that may not read a
 * secret could read it by sending a script. Called before anything is composed, so nothing has been
 * sent when the refusal arrives. Scripts stored on a request or collection are not covered: that is
 * a write-tool residual (`docs/engine/mcp/safety.md`), and they run as stored when `run_request`
 * sends a saved request by `requestId`.
 *
 * @p elements is the call's `elements` entries, for a tool that takes them as a list
 * (`start_load_run`'s `elements` is a different, run-level object).
 */
export function refuseAgentScripts(
	args: Record<string, unknown>,
	ctx: ToolContext,
	elements: readonly unknown[] = []
): void {
	if (ctx.config.revealSecretsToAgents) return;
	const named: string[] = ["preRequestScript", "postRequestScript", "tests"].filter((key) => {
		const text = str(args, key);
		return text !== undefined && !BLANK_SCRIPT.test(text);
	});
	if (elements.some(carriesScript)) named.push("elements");
	if (named.length === 0) return;
	throw new ToolArgError(
		`${named.map((key) => `"${key}"`).join(", ")} carries a script, and agents cannot send one while Reveal secrets to agents is off: a script reads every variable, secret ones included, and could write the value into its output or the request it sends. Nothing was sent. Leave the script out, or ask the user to ${settingRemedy("revealSecretsToAgents", ctx.host)}.`,
		"policy"
	);
}

/**
 * The element kind a script of each phase becomes on the wire (issue #1512). Since #1514's clean
 * cut, `elements` is the only script field `/requests`, `/collections` and `/execute` accept: a
 * script is an entry of one of these kinds carrying its text at `config.script`, and the old
 * `preRequestScript` / `postRequestScript` / `tests` keys are refused with a 400 naming `elements`.
 *
 * The MCP tools keep the *old argument names* (an agent still writes `preRequestScript` /
 * `postRequestScript`) because renaming the tool surface is issue #1517's job, not this
 * translation's. So the one-script-per-phase <-> `elements` conversion lives in these three helpers
 * rather than in each of the six handlers that need it.
 */
const SCRIPT_ELEMENT_KINDS = { pre: "script.pre", post: "script.post" } as const;

/**
 * Kinds the engine accepts only on a collection (`collectionOnly` in `GET /elements/kinds`).
 * `electron/` compiles with `rootDir: electron` and cannot import the renderer's copy
 * (`COLLECTION_ONLY_KINDS` in `src/modules/request-builder/utils/elements-parts.ts`); both are held
 * to the same catalogue fixture by `element-kinds.conformance.test.ts` here and
 * `scenario-only.conformance.test.ts` there.
 */
export const COLLECTION_ONLY_KINDS: ReadonlySet<string> = new Set([
	"script.setup",
	"script.teardown",
]);

/**
 * Whether a composed element is a collection's own run-boundary script. `POST /compose` emits an
 * enabled collection or folder `script.setup` / `script.teardown` with a collection `origin`, but
 * `POST /runs` validates `requestElements` as a request's own and refuses the kind (#3070); they
 * belong to the collection's own run, so a single-request load run leaves them out, as the app's
 * load dialog does (`withoutInheritedCollectionOnly`).
 */
function isInheritedCollectionOnly(el: unknown): boolean {
	return (
		isRecord(el) &&
		isRecord(el.origin) &&
		el.origin.kind === "collection" &&
		typeof el.kind === "string" &&
		COLLECTION_ONLY_KINDS.has(el.kind)
	);
}

/**
 * One `elements` entry carrying a script. `id` is optional because the destinations differ:
 * `POST /requests` and `POST /collections` stamp an `el_` id onto an entry that names none
 * (`apply_elements_field`), the engine's own storage contract, which beats inventing an id that two
 * rows would share. `/execute` stores and assigns nothing, so ad-hoc callers pass a stable id:
 * per-element outcomes come back keyed by it, and an empty one reports as anonymous.
 */
export function scriptElement(
	which: "pre" | "post",
	script: string,
	id?: string
): Record<string, unknown> {
	return {
		...(id !== undefined ? { id } : {}),
		kind: SCRIPT_ELEMENT_KINDS[which],
		enabled: true,
		config: { script },
	};
}

/**
 * Merge one script argument into a target's stored `elements` list. Find-or-create against the
 * **first** element of that kind: an existing one keeps its id, name and position and only takes
 * the new text, and an empty string removes it, which is how `update_request` / `update_collection`
 * clear a script. Everything else in the list (the other phase's script, a second script of the
 * same kind, an extractor, an assertion) is carried through untouched, which is why the caller
 * reads the stored list first rather than writing a fresh one-element array over it.
 *
 * First-match rather than collapse-all is the conservative half of that rule: MCP exposes one
 * script per phase and the engine joins every enabled one, so a list holding two could be read
 * either way. Rewriting only the one this surface can address leaves an app-authored second element
 * alone; #1517, which gives the tools real `elements` arguments, is what lets an agent address it.
 */
export function upsertScriptElement(
	stored: unknown,
	which: "pre" | "post",
	script: string
): Record<string, unknown>[] {
	const kind = SCRIPT_ELEMENT_KINDS[which];
	const existing = Array.isArray(stored) ? stored : [];
	const out: Record<string, unknown>[] = [];
	let matched = false;
	for (const entry of existing) {
		if (!isRecord(entry)) continue;
		if (matched || entry.kind !== kind) {
			out.push(entry);
			continue;
		}
		matched = true;
		// An empty string clears the script: drop the element rather than leave
		// an enabled entry whose `config.script` runs nothing.
		if (script !== "") {
			out.push({
				...entry,
				config: { ...(isRecord(entry.config) ? entry.config : {}), script },
			});
		}
	}
	if (!matched && script !== "") out.push(scriptElement(which, script));
	return out;
}

/**
 * The script arguments a create/update tool was given, as `[phase, text]` pairs. An empty string is
 * a value, not an omission: it is how `update_request` and `update_collection` clear a stored
 * script, which `upsertScriptElement` turns into a removal. An argument the agent did not name is
 * absent from the list and leaves the stored element alone.
 */
export function readScriptEdits(args: Record<string, unknown>): ["pre" | "post", string][] {
	const edits: ["pre" | "post", string][] = [];
	for (const which of ["pre", "post"] as const) {
		const value = str(args, `${which}RequestScript`);
		if (value !== undefined) edits.push([which, value]);
	}
	return edits;
}

/** An auth block as stored/forwarded (discriminated by `mode`). */
type AuthRecord = Record<string, unknown> & { mode?: string };

/**
 * Read an optional agent-supplied `auth` block (a `{ mode, … }` object).
 *
 * A block copied from a read that withheld its credentials is refused: stored,
 * it would replace the user's credential with nothing, and sent, it would
 * authenticate with nothing. So is one carrying the `<redacted>` marker of a
 * run's record as a credential, unless the session reveals secrets (#3553).
 */
export function readAuthArg(
	args: Record<string, unknown>,
	ctx: ToolContext
): AuthRecord | undefined {
	const a = args.auth;
	if (!isRecord(a)) return undefined;
	const withheld = withheldAuthMembers(a);
	if (withheld.length > 0) {
		throw new ToolArgError(
			`"auth" carries ${withheld.join(", ")}: ${READ_WITHHELD_REASON}. Leave "auth" out to keep what is stored, or pass the block with real values or {{variable}} references.`
		);
	}
	refuseRedactedAuth(ctx, a);
	return a as AuthRecord;
}

/**
 * The column names a run's `data` rows declare: every row's keys, first seen first. All rows, not
 * the first: rows may be ragged and the engine binds the union. A non-object row has no columns,
 * and an empty key is skipped because `POST /compose` refuses an empty `dataColumns` entry with a
 * `400`.
 */
function dataColumnNames(data: unknown): string[] {
	if (!Array.isArray(data)) return [];
	const names = new Set<string>();
	for (const row of data) {
		if (!isRecord(row)) continue;
		for (const key of Object.keys(row)) {
			if (key !== "") names.add(key);
		}
	}
	return [...names];
}

/**
 * Build the request half of a `POST /runs` body: everything except the load shape (mode, duration,
 * concurrency...).
 *
 * **Two shapes, one rule.** Given a `requestId`, `POST /compose` composes the saved request as the
 * app composes it for a load run and `run_collection_smoke` for a Send: variables resolved, stored
 * auth applied through the collection chain, and the chain's and its own elements attached under
 * `elements` (issue #1514; script.pre/script.post among them, since a load run has no
 * `POST /compose` output shape of its own). Anything the agent states (url, method, headers, body,
 * auth, tests) is laid over the stored request *before* resolution, so overrides carrying
 * `{{variables}}` resolve too. Without a `requestId` the run is ad-hoc and `url` is required.
 *
 * **The two endpoints spell the resolved chain under different keys, so this translates.**
 * `POST /compose` returns `elements`; a single-target `POST /runs` reads its step-level elements
 * under `requestElements` (issue #1594), a key distinct from `elements` there, which is the
 * run-level `timers`/`scripts` override object `args.elements` becomes. So the composed list is
 * renamed onto the payload, not copied.
 *
 * **`script.pre` reaches the wire only when marked.** It runs inline, per submission, when its own
 * `config.inline` is set or the run's `elements.scripts` override forces it; left `asMarked` with
 * no per-element mark it never runs (there is no pre-request replay to defer it to, unlike
 * `script.post`). `droppedPreRequestScripts` folds `args.elements.scripts` into the count itself
 * ("allInline" drops it to 0, "allDeferred" counts every enabled `script.pre` whatever its mark),
 * so the caller only checks whether the count is non-zero.
 *
 * **A run's `data` rows tell composition which bare names are columns.** The engine leaves a bare
 * `{{email}}` written for the per-iteration bind only when told `email` is a bound column;
 * otherwise a same-named environment variable answers at composition and the row's value never wins
 * (issue #2956, #1007). So `dataColumns` is the union of every row's keys, the set the engine binds
 * against, and is left off when there are no rows.
 */
export async function composeLoadRunRequest(
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<{ payload: Record<string, unknown>; droppedPreRequestScripts: number }> {
	refuseAgentScripts(args, ctx);
	const savedId = str(args, "requestId");
	const overrides = readRequestOverrides(args, ctx);
	const authArg = readAuthArg(args, ctx);
	if (authArg) overrides.auth = authArg;

	const composeBody: Record<string, unknown> = {
		collectionId: str(args, "collectionId"),
		// This payload is repeated once per iteration per virtual user, so the `{{$guid}}` family
		// belongs to each repetition, not to this one-time composition: leave the tokens as written
		// and let the engine generate a fresh value per iteration at bind time (issue #995).
		deferDynamicVariables: true,
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
	composeBody.environmentId = await resolveEnvironmentId(args, ctx, signal);
	const dataColumns = dataColumnNames(args.data);
	if (dataColumns.length > 0) composeBody.dataColumns = dataColumns;

	const payload = await composeViaEngine(ctx.client, composeBody, signal);

	// Mirrors `RunContext::script_element_runs_inline` (engine-side): the run's `elements.scripts`
	// override, when present, decides for every `script.pre` element regardless of its own
	// `config.inline` ("allInline" runs all, "allDeferred" none); only its absence falls back to
	// each element's own mark.
	const scriptsOverride =
		isRecord(args.elements) && typeof args.elements.scripts === "string"
			? args.elements.scripts
			: undefined;
	const droppedPreRequestScripts = Array.isArray(payload.elements)
		? payload.elements.filter((el) => {
				if (!isRecord(el) || el.kind !== SCRIPT_ELEMENT_KINDS.pre || el.enabled === false) {
					return false;
				}
				if (scriptsOverride === "allInline") return false;
				if (scriptsOverride === "allDeferred") return true;
				return !(isRecord(el.config) && el.config.inline === true);
			}).length
		: 0;

	// An agent-written validation script replaces every composed `script.post` element rather than
	// joining them: with no way to know which the agent meant, running both would add assertions
	// they never asked for. The only place a post-request script is placed on this array; the
	// handler adds none.
	const adHocScript = readValidationScript(args);
	let elements = (Array.isArray(payload.elements) ? payload.elements : []).filter(
		(el) => !isInheritedCollectionOnly(el)
	);
	if (adHocScript !== undefined) {
		elements = elements.filter(
			(el) => !(isRecord(el) && el.kind === SCRIPT_ELEMENT_KINDS.post)
		);
		if (adHocScript !== "") {
			elements = [...elements, scriptElement("post", adHocScript, "mcp-script-post")];
		}
	}
	delete payload.elements;
	if (elements.length > 0) payload.requestElements = elements;

	return { payload, droppedPreRequestScripts };
}

/**
 * Mode `start_load_run` sends when the agent names none and no rate: closed-loop and
 * duration-bounded, so an unspecified run is one the duration cap can hold. The engine's mode-less
 * strategy is the same constant strategy (closed loop without a rate), so the two agree. See
 * {@link defaultModeFor} for the rate case.
 */
export const DEFAULT_LOAD_MODE: LoadMode = "constant_concurrency";

/**
 * The mode of a run whose agent named none: `constant_rps` when it gave a positive `targetRps`,
 * since only that mode paces at a rate and the engine refuses the rate on any other (#2396);
 * {@link DEFAULT_LOAD_MODE} otherwise. A mode the agent did name is never replaced: a rate beside a
 * non-constant_rps one is forwarded for the engine to refuse, so that rule lives in one place.
 */
function defaultModeFor(params: LoadRunParams): LoadMode {
	return (params.targetRps ?? 0) > 0 ? "constant_rps" : DEFAULT_LOAD_MODE;
}

/**
 * The run `start_load_run` will start: the stated load fields, plus every one
 * the engine would otherwise default for this mode, written out (#2437).
 * `closedLoop` is false only when a `targetRps` paces a `constant_rps` run.
 */
export interface LoadShape extends LoadRunParams {
	mode: string;
	closedLoop: boolean;
}

/**
 * The load fields an agent stated, as both load paths read them. `targetRps` is
 * the single-target path's to add: a scenario run refuses a rate outright.
 */
export function readLoadParams(args: Record<string, unknown>): LoadRunParams {
	return {
		mode: str(args, "mode"),
		concurrency: num(args, "concurrency"),
		startConcurrency: num(args, "startConcurrency"),
		iterations: num(args, "iterations"),
		duration: str(args, "duration"),
		rampUpDuration: str(args, "rampUpDuration"),
		stepDuration: str(args, "stepDuration"),
	};
}

/** Seconds as the duration text `POST /runs` reads, or undefined for none. */
function durationText(seconds: number | undefined): string | undefined {
	return seconds === undefined ? undefined : `${seconds}s`;
}

/**
 * Resolve the effective load shape from the stated params, so the caps, the preview, the payload
 * and the stored run all read the same values (#2437). A stated value is never replaced. An omitted
 * `duration` is the engine's default for the mode, or the duration cap when that is shorter: sent
 * explicitly, the cap is what bounds a run that said nothing. @p defaults is the executor's table:
 * the single-target strategies' unless a scenario run passes its own.
 */
export function resolveLoadShape(
	params: LoadRunParams,
	config: McpSafetyConfig,
	defaults: LoadDefaultsTable = ENGINE_LOAD_DEFAULTS
): LoadShape {
	const mode = params.mode ?? defaultModeFor(params);
	const stated = { ...params, mode };
	const row = defaults[engineLoadMode(stated)] ?? {};
	const paced = row.ratePaced === true && (params.targetRps ?? 0) > 0;
	const durationSeconds =
		row.durationSeconds === undefined
			? undefined
			: Math.min(row.durationSeconds, config.maxDurationSeconds);
	const resolved: LoadRunParams = {
		...stated,
		// A paced run never reads `concurrency`, so none is invented for it.
		concurrency: params.concurrency ?? (paced ? undefined : row.concurrency),
		startConcurrency: params.startConcurrency ?? row.startConcurrency,
		iterations: params.iterations ?? row.iterations,
		duration: params.duration ?? durationText(durationSeconds),
		rampUpDuration: params.rampUpDuration ?? durationText(row.rampUpDurationSeconds),
	};
	const present = Object.entries(resolved).filter(([, value]) => value !== undefined);
	return {
		...(Object.fromEntries(present) as LoadRunParams),
		mode,
		closedLoop: !paced,
	};
}

/** The `POST /runs` fields of a shape: all of it but `closedLoop`, which is derived. */
export function loadShapePayload(shape: LoadShape): Record<string, unknown> {
	const { closedLoop: _closedLoop, ...fields } = shape;
	return fields;
}

/** A duration as words for the preview, "60 s"; the text as given if it does not parse. */
function durationWords(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const seconds = parseDurationSeconds(value);
	return seconds === null ? String(value) : `${seconds} s`;
}

/** How many virtual users the shape runs, or the rate that paces it, as words. */
function loadWidthWords(shape: LoadShape, mode: LoadMode): string | undefined {
	if (!shape.closedLoop) return `${shape.targetRps} requests/s`;
	if (shape.concurrency === undefined) return undefined;
	if (mode === "ramp_up") {
		return `${shape.startConcurrency} to ${shape.concurrency} virtual users over ${durationWords(shape.rampUpDuration)}`;
	}
	if (mode === "capacity") return `up to ${shape.concurrency} virtual users`;
	return `${shape.concurrency} virtual users`;
}

/**
 * The shape in words for a confirmation summary: "constant_concurrency, 100
 * virtual users, closed loop, 60 s". An iterations run states its count, since
 * it never reads a duration.
 */
export function describeLoadShape(shape: LoadShape): string {
	const mode = engineLoadMode(shape);
	const length =
		mode === "iterations" ? `${shape.iterations} iterations` : durationWords(shape.duration);
	return [
		shape.mode,
		loadWidthWords(shape, mode),
		shape.closedLoop ? "closed loop" : "open loop",
		length,
	]
		.filter((part) => part !== undefined)
		.join(", ");
}

/**
 * The engine's `maxInFlight` guard (`run_config::MAX_IN_FLIGHT` in
 * `engine/include/vayu/core/constants.hpp`), mirrored so the schema rejects an out-of-range value
 * by name instead of surfacing a 400. A literal, not an import: production code in `electron/` may
 * not reach into `src/` (`tsconfig.node.json` withholds the `@/*` mapping on purpose). The copy is
 * kept honest from the test side, as the dynamic-variable table is: `tools/load.tools.test.ts` ties
 * it to the renderer's `LOAD_TEST_LIMITS`, and `src/constants/load-test.engine-parity.test.ts` ties
 * that to this header.
 */
export const MAX_IN_FLIGHT_BOUND = 1_000_000;

/**
 * The engine's guards on the numeric recording knobs (`validate_run_config`,
 * `engine/src/http/routes/execution.cpp`), mirrored for the reason {@link MAX_IN_FLIGHT_BOUND} is.
 * The two response sample bounds, which size the sampled replay's population and not
 * `get_run_samples`, are `response_sample_rate` (a period, so 1 and up) and `max_response_samples`
 * (`run_config::MAX_RESPONSE_SAMPLES`; 0 keeps none). Deliberately *not* the load dialog's own
 * ceilings: `LOAD_TEST_LIMITS` narrows the slow threshold to a minute because that suits a slider,
 * not because the engine refuses more, and a tool copying the slider's bound would refuse runs the
 * engine accepts and the app cannot compose.
 */
export const MAX_SUCCESS_SAMPLE_PERIOD = 100_000;
export const MAX_SLOW_THRESHOLD_MS = 86_400_000;
export const MAX_RESPONSE_SAMPLE_PERIOD = 100_000;
export const MAX_RESPONSE_SAMPLES_BOUND = 1_000_000;
/** `limits::MAX_RETRY_AFTER_MAX_MS`: `retryAfterMaxMs` is 1 up to this (#3782). */
export const MAX_RETRY_AFTER_MAX_MS = 3_600_000;

/**
 * The redirect ceiling `apply_request_fields` clamps a stored request to
 * (`std::clamp (r.max_redirects, 0, 100)`). `POST /runs` has no guard of its own and the field
 * reaches the engine's redirect chain as an `int`, where a negative means *unlimited*
 * (`redirect_limit_reached`), so this schema is the only thing between an agent's
 * `maxRedirects: -1` and a run that follows redirects forever. Refused rather than clamped, like
 * every other bound here: a silently changed value is a run measuring something the agent did not
 * ask for. Read by both surfaces that take the field, `requestSettingsInput` (a saved request,
 * issue #759) and `start_load_run` (a composed payload, #760), so they cannot disagree about what
 * the engine accepts.
 */
export const MAX_REDIRECTS_BOUND = 100;

/**
 * The recording knobs of a load run, plus its Retry-After back-off pair (#3782), as
 * `{tool argument: run config key}`. Two spellings because the engine's are snake_case here and
 * only here: `success_sample_rate` and `response_sample_rate` are not rates but *periods* (keep 1
 * in N), as the app's `StartLoadTestRequest` notes. The argument is named for what the value means;
 * the payload key stays the engine's, so `get_run_report`'s echo of the config snapshot matches
 * what the run was started with. The load dialog sends the first three and neither response-sample
 * key (#2447), so only an agent changes the responses the sampled script and schema replay runs
 * over. Those two keys do not feed `get_run_samples` (#3555): it reads the exchanges the engine
 * kept for errors, slow outliers and the first three per status code.
 */
const LOAD_RECORDING_FIELDS: ReadonlyArray<[argument: string, configKey: string]> = [
	["successSamplePeriod", "success_sample_rate"],
	["slowRequestThresholdMs", "slow_threshold_ms"],
	["saveTimingBreakdown", "save_timing_breakdown"],
	["responseSamplePeriod", "response_sample_rate"],
	["maxResponseSamples", "max_response_samples"],
	// camelCase on the wire, so the same spelling twice: the option is read from
	// the run config by `RunContext`, which both load executors share.
	["retryAfterBackoff", "retryAfterBackoff"],
	["retryAfterMaxMs", "retryAfterMaxMs"],
];

/**
 * Copy the recording knobs, the Retry-After back-off pair and the run comment onto a `POST /runs`
 * payload. Shared by both load paths because both read them: a scenario load run is driven by the
 * same `RunContext`, whose constructor is the one place `success_sample_rate` /
 * `save_timing_breakdown` / `slow_threshold_ms` and the two response-sample keys are read
 * (`core/run_manager.cpp`), and `comment` is lifted into the run summary and the report's
 * `metadata.configuration` by `routes/runs.cpp` whichever executor produced the run. Forwarding on
 * one path only would be a knob that silently does nothing on the other.
 *
 * Absent stays absent, never defaulted: each has an engine default a stated value would overwrite,
 * and "said nothing" and "asked for the default" are the same run only by accident.
 */
export function applyRecordingKnobs(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	for (const [argument, configKey] of LOAD_RECORDING_FIELDS) {
		const value = args[argument];
		if (typeof value === "number" || typeof value === "boolean") payload[configKey] = value;
	}
	const comment = str(args, "comment");
	if (comment !== undefined) payload.comment = comment;
}

/**
 * Copy the default-header opt-outs onto an execute or run payload (issue #1337). Beside the
 * composed payload rather than through composition, as `data` is: an opt-out is neither a
 * `{{variable}}` nor the auth chain but a send-time fact about the engine's own defaults, never
 * stored on a request and never interpolated; `POST /execute` and `POST /runs` read it off the
 * payload. Absent stays absent: an empty list and no list say the same to the engine, and sending
 * one where the agent named none would be this layer making a claim on its behalf.
 */
export function applyDefaultHeaderOptOuts(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	const names = args.disabledDefaultHeaders;
	if (Array.isArray(names)) payload.disabledDefaultHeaders = names;
}
