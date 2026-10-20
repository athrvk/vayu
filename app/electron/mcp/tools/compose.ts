/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file compose.ts
 * @brief The request an execute or load tool sends: argument overrides,
 *        engine-side composition, the streaming read, the agent-script gate and
 *        the load-run payload with its bounds.
 */

import type { McpSafetyConfig } from "../config.js";
import { type EngineClient, EngineRequestError } from "../engine-client.js";
import {
	ENGINE_LOAD_DEFAULTS,
	engineLoadMode,
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
	jsonResult,
	num,
	optionalPositiveInt,
	requireStr,
	str,
	structuredResult,
	ToolArgError,
} from "./kit.js";
import { bodyPayload, INLINE_FILE_REFUSAL } from "./request-body.js";
import { selectEnvironment } from "./variable-blobs.js";
import { REVEAL_SETTING_TOKEN, settingRemedy } from "../remedy.js";

/**
 * The `headers` an agent passed: the ordered `[{ name, value }]` lines, a
 * repeated name sent once per line in order (issue #2466), or the single-valued
 * `{ name: value }` map, one line per key. Both go to `POST /compose` as given;
 * it answers lines either way.
 *
 * A line that is not an object with a string `name` is refused here by name
 * rather than forwarded for the engine to refuse without saying which one.
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
export function readRequestOverrides(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	// Upper-cased because the engine's `parse_method` matches the verb exactly
	// (compose normalises this too; being explicit keeps previews readable).
	const method = str(args, "method");
	if (method !== undefined) out.method = method.toUpperCase();
	const url = str(args, "url");
	if (url !== undefined) out.url = url;
	const headers = readHeaderOverrides(args.headers);
	if (headers !== undefined) out.headers = headers;
	// Before anything is composed: an inline body is never a file, because
	// nothing here can stand for the person who has to choose it.
	if (str(args, "bodyType") === "binary" || args.file !== undefined) {
		throw new ToolArgError(INLINE_FILE_REFUSAL);
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
	// Redirect policy is part of the request half, not the load shape: the app
	// sends both fields through `POST /compose` beside the method and the body
	// (`request-builder/index.tsx`), and the engine emits them on every composed
	// payload under the never-elided rule. Only `start_load_run` declares them -
	// `run_request` has no such argument, so nothing can arrive here from it -
	// because an ad-hoc load target has no saved request whose stored policy the
	// run could inherit.
	if (typeof args.followRedirects === "boolean") out.followRedirects = args.followRedirects;
	if (typeof args.maxRedirects === "number") out.maxRedirects = args.maxRedirects;
	return out;
}

/**
 * The payload as `POST /execute` / `POST /runs` receives it from this server:
 * marked as an MCP-started run, naming the handshake's client when one is
 * known (#1817). Applied at the send, after every argument has been folded in,
 * so nothing a caller passes can claim another origin. The name goes as the
 * client sent it; the engine trims and caps it.
 */
export function withMcpOrigin(
	payload: Record<string, unknown>,
	ctx: ToolContext
): Record<string, unknown> {
	const client = ctx.clientName?.();
	return { ...payload, origin: client === undefined ? { kind: "mcp" } : { kind: "mcp", client } };
}

/**
 * Compose a request engine-side and return the execute-ready payload.
 *
 * This is the one place MCP's execute/load tools obtain a resolved request:
 * `POST /compose` owns `{{variable}}` interpolation and the `inherit` auth
 * walk (issue #226 deleted the MCP-side copy). Composition is pure - nothing
 * is sent - which is what lets the caller run the allowlist gate on the
 * *resolved* URL before any traffic flows, and the composed payload is passed
 * to `/execute` or `/runs` unchanged: a value composition substituted is never
 * substituted again. What the engine does resolve past this point is the
 * leftovers - a name composition could not answer keeps its braces (#1009) and
 * is resolved after the pre-request script, before the send (#1008) - which is
 * why the gate refuses an unresolved *authority* rather than checking one.
 *
 * A 404 for a named `requestId` surfaces as a {@link ToolArgError} so the
 * agent reads "no such saved request", not a transport failure.
 */
export async function composeViaEngine(
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
 * The `environmentId` a send composes with: the active environment when the
 * call names none, nothing for `"none"`, and a {@link ToolArgError} for an id
 * no environment has (#2480). `POST /compose` degrades an unknown id to an
 * empty scope, so without this a mistyped id would send every environment
 * token literally with nothing naming the cause.
 *
 * Call it once per tool call, before any compose: a sequence that resolved it
 * per step would turn one bad argument into one failure per step.
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
export const DEFAULT_STREAM_MAX_EVENTS = 50;
export const DEFAULT_STREAM_BUDGET_MS = 5_000;
/** A ceiling on the ceiling: `tools/call` is request/response, and a caller
 *  that asked to wait five minutes would hold the whole MCP session. */
export const MAX_STREAM_BUDGET_MS = 60_000;

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
			`"streamBudgetMs" must be ${MAX_STREAM_BUDGET_MS} or less - a tool call cannot hold the session longer. Start the stream, then follow it with get_run and read it with get_run_report.`
		);
	}

	let started: Record<string, unknown>;
	try {
		const accepted = await ctx.client.executeRequest(withMcpOrigin(payload, ctx), signal);
		if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) {
			return errorResult("Engine returned an unusable answer for a streaming request.");
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
		return jsonResult(withhold(started));
	}

	let consumed;
	try {
		consumed = await ctx.client.consumeStreamEvents(runId, maxEvents, budgetMs, signal);
	} catch (err) {
		return engineErrorResult(err, ctx);
	}

	const withhold = await runOutputShape(ctx, signal, [payload.auth]);
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
		events: withhold(consumed.events),
		nextStep: consumed.completed
			? "The stream has ended. get_run_report has the stored events and any test results."
			: "The run is still streaming engine-side. get_run says whether it is done and get_run_report reads the events stored so far; end it with stop_run.",
	});
}

/**
 * The post-response validation script an agent supplied, under either name.
 *
 * One concept, historically two engine keys: `POST /execute` grew up calling it
 * `postRequestScript`, `POST /runs` calls it `tests`. The two endpoints have
 * since diverged - `/execute` takes `elements` and refuses both old spellings
 * (issue #1514), while `/runs` still reads `tests` - so this returns the script
 * as a plain string and each caller spells it the way its own endpoint wants.
 * MCP names it `postRequestScript` on both tools regardless - the way the app's
 * single **Tests** tab drives Send and a load run alike - and keeps `tests`
 * accepted as the engine's own spelling on the run tools. Supplying both is
 * rejected rather than silently resolved: with no way to know which the agent
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
 * An `elements` entry that would run script text. The kind is folded and
 * trimmed although the engine matches it exactly (`Registry::find`): a
 * refusal that tracked the engine's current spelling would be one normalising
 * change away from a bypass, and a variant the engine rejects is refused here
 * for the right reason anyway.
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
 * Refuse a script the agent wrote while Reveal secrets to agents is off (#1834).
 *
 * A script runs in a sandbox that reads every variable the request resolves
 * against, secret ones included, and can write one into a test result, a
 * variable or the request it sends - so an agent that may not read a secret
 * could read it by sending a script. Called before anything is composed, so
 * nothing has been sent when the refusal arrives. Scripts stored on a request
 * or collection are not covered: that is a write-tool residual
 * (`docs/engine/mcp.md`), and they run as stored when `run_request` sends a
 * saved request by `requestId`.
 *
 * @p elements is the call's `elements` entries, for a tool that takes them as
 * a list (`start_load_run`'s `elements` is a different, run-level object).
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
		`${named.map((key) => `"${key}"`).join(", ")} carries a script, and agents cannot send one while Reveal secrets to agents is off: a script reads every variable, secret ones included, and could write the value into its output or the request it sends. Nothing was sent. Leave the script out, or ask the user to ${settingRemedy("revealSecretsToAgents", ctx.host)}.`
	);
}

/**
 * The element kind a script of each phase becomes on the wire (issue #1512).
 *
 * Since #1514's clean cut, `elements` is the only script field `/requests`,
 * `/collections` and `/execute` accept: a script is an entry of one of these
 * kinds carrying its text at `config.script`, and the old `preRequestScript` /
 * `postRequestScript` / `tests` keys are refused outright with a 400 naming
 * `elements`.
 *
 * The MCP tools deliberately keep the *old argument names*: an agent still
 * writes `preRequestScript` / `postRequestScript`, because renaming the tool
 * surface is issue #1517's job, not this translation's. So the whole
 * one-script-per-phase <-> `elements` conversion lives in these three helpers
 * rather than being spelled out in each of the six handlers that need it.
 */
const SCRIPT_ELEMENT_KINDS = { pre: "script.pre", post: "script.post" } as const;

/**
 * One `elements` entry carrying a script.
 *
 * `id` is optional because the two destinations differ: `POST /requests` and
 * `POST /collections` stamp an `el_` id onto an entry that names none
 * (`apply_elements_field`), which is the engine's own storage contract and
 * beats inventing an id here that two different rows would share. `/execute`
 * stores nothing and assigns nothing, so the ad-hoc callers pass a stable id -
 * per-element outcomes come back keyed by it, and an empty one reports as
 * anonymous.
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
 * Merge one script argument into a target's stored `elements` list.
 *
 * Find-or-create against the **first** element of that kind: an existing one
 * keeps its id, name and position and only takes the new text, and an empty
 * string removes it, which is how `update_request` / `update_collection` clear
 * a script. Everything else in the list is carried through untouched - the
 * other phase's script, a second script of the same kind, an extractor, an
 * assertion - which is the whole reason the caller reads the stored list first
 * instead of writing a fresh one-element array over it.
 *
 * First-match rather than collapse-all is the conservative half of that rule:
 * MCP exposes one script per phase and the engine joins every enabled one, so a
 * list holding two could be read either way. Rewriting only the one this
 * surface can address leaves an app-authored second element alone; #1517, which
 * gives the tools real `elements` arguments, is what lets an agent address it.
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
 * The script arguments a create/update tool was actually given, as
 * `[phase, text]` pairs.
 *
 * An empty string is a value here rather than an omission - it is how
 * `update_request` and `update_collection` clear a stored script, which
 * `upsertScriptElement` turns into a removal. An argument the agent did not
 * name at all is absent from the list, and leaves the stored element alone.
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
 * authenticate with nothing.
 */
export function readAuthArg(args: Record<string, unknown>): AuthRecord | undefined {
	const a = args.auth;
	if (!isRecord(a)) return undefined;
	const withheld = withheldAuthMembers(a);
	if (withheld.length > 0) {
		throw new ToolArgError(
			`"auth" carries ${withheld.join(", ")}: it was read with its credentials withheld, so it holds no credential to store or send. Leave "auth" out to keep what is stored, or pass the block with real values or {{variable}} references.`
		);
	}
	return a as AuthRecord;
}

/**
 * Build the request half of a `POST /runs` body - everything except the load
 * shape (mode, duration, concurrency…).
 *
 * **Two shapes, one rule.** Given a `requestId`, `POST /compose` composes the
 * saved request exactly as the app composes it for a load run and as
 * `run_collection_smoke` composes it for a Send - variables resolved, its
 * stored auth applied through the collection chain, and the chain's + its own
 * elements attached under `elements` (issue #1514 - script.pre/script.post
 * among them, since a load run has no `POST /compose` output shape of its
 * own). Anything the agent states explicitly - url, method, headers, body,
 * auth, tests - is laid over the stored request *before* resolution, so
 * overrides carrying `{{variables}}` resolve too. Without a `requestId` the
 * run is ad-hoc and `url` is required.
 *
 * **The two endpoints spell the resolved chain under different keys, so this
 * translates.** `POST /compose` returns it as `elements`; a single-target
 * `POST /runs` reads its own step-level elements under `requestElements`
 * instead (issue #1594) - a distinct key from `elements` there, which is the
 * run-level `timers`/`scripts` override object `args.elements` becomes. So the
 * composed list is renamed onto the payload rather than copied verbatim.
 *
 * **`script.pre` can reach the wire now, but only when marked.** Before issue
 * #1594, `POST /runs` ran no element pipeline at all, so a saved request's
 * pre-request script never applied under load - `droppedPreRequestScripts`
 * existed to say so. Now a `script.pre` element runs inline, per submission,
 * when its own `config.inline` is set or the run's `elements.scripts`
 * override forces it; left `asMarked` with no per-element mark, it still
 * never runs (there is no pre-request replay to defer it to, unlike
 * `script.post`). `droppedPreRequestScripts` folds `args.elements.scripts`
 * into the count itself - "allInline" drops it to 0, "allDeferred" counts
 * every enabled `script.pre` regardless of its own mark - so the caller only
 * has to check whether the count is non-zero, not re-read the override too.
 */
export async function composeLoadRunRequest(
	args: Record<string, unknown>,
	ctx: ToolContext,
	signal?: AbortSignal
): Promise<{ payload: Record<string, unknown>; droppedPreRequestScripts: number }> {
	refuseAgentScripts(args, ctx);
	const savedId = str(args, "requestId");
	const overrides = readRequestOverrides(args);
	const authArg = readAuthArg(args);
	if (authArg) overrides.auth = authArg;

	const composeBody: Record<string, unknown> = {
		collectionId: str(args, "collectionId"),
		// This composed payload is repeated once per iteration, per virtual
		// user, so the `{{$guid}}` family belongs to each repetition, not to
		// this one-time composition - leave the tokens written as-is and let
		// the engine generate a fresh value per iteration at bind time
		// (issue #995).
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

	const payload = await composeViaEngine(ctx.client, composeBody, signal);

	// Mirrors `RunContext::script_element_runs_inline` (engine-side): the
	// run's own `elements.scripts` override, when present, decides for every
	// `script.pre` element regardless of its own `config.inline` - "allInline"
	// runs every one of them, "allDeferred" runs none, and only the absence of
	// an override falls back to each element's own mark. Reading only
	// `config.inline` here (as an earlier version of this function did) missed
	// the "allDeferred" case: a request whose `script.pre` was individually
	// marked inline would count as not dropped, when the override forces it
	// deferred anyway - the caveat below would then say nothing about a script
	// that, in fact, never ran.
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

	// An agent-written validation script replaces every composed `script.post`
	// element rather than joining them: with no way to know which the agent
	// meant, running both would add assertions they never asked for. This is
	// the only place a post-request script is placed on this array - the
	// handler does not add one again.
	const adHocScript = readValidationScript(args);
	let elements = Array.isArray(payload.elements) ? payload.elements : [];
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
 * Mode `start_load_run` sends when the agent names none. Closed-loop and
 * duration-bounded, so an unspecified run is one the duration cap can hold.
 */
export const DEFAULT_LOAD_MODE: LoadMode = "constant_concurrency";

/**
 * The run `start_load_run` will start: the stated load fields, plus every one
 * the engine would otherwise default for this mode, written out (#2437).
 * `closedLoop` is false only when a `targetRps` paces a constant run.
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
 * Resolve the effective load shape from the stated params, so the caps, the
 * preview, the payload and the stored run all read the same values (#2437).
 * A stated value is never replaced. An omitted `duration` is the engine's
 * default for the mode, or the duration cap when that is shorter: sent
 * explicitly, the cap is what bounds a run that said nothing.
 *
 * @p defaults is the executor's table: the single-target strategies' unless a
 * scenario run passes its own.
 */
export function resolveLoadShape(
	params: LoadRunParams,
	config: McpSafetyConfig,
	defaults: LoadDefaultsTable = ENGINE_LOAD_DEFAULTS
): LoadShape {
	const mode = params.mode ?? DEFAULT_LOAD_MODE;
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

/**
 * The engine's guards on the numeric recording knobs
 * (`validate_run_config`, `engine/src/http/routes/execution.cpp`), mirrored for
 * the reason {@link MAX_IN_FLIGHT_BOUND} is: the schema refuses an
 * out-of-range value by name instead of surfacing a `400`. The two response
 * sample bounds are `response_sample_rate` (a period, so 1 and up) and
 * `max_response_samples` (`run_config::MAX_RESPONSE_SAMPLES`; 0 keeps none).
 *
 * Deliberately *not* the load dialog's own ceilings - `LOAD_TEST_LIMITS`
 * narrows the slow threshold to a minute because that is a sensible thing to
 * put on a slider, not because the engine refuses more. A tool that copied the
 * slider's bound would refuse runs the engine accepts and the app cannot
 * compose.
 */
export const MAX_SUCCESS_SAMPLE_PERIOD = 100_000;
export const MAX_SLOW_THRESHOLD_MS = 86_400_000;
export const MAX_RESPONSE_SAMPLE_PERIOD = 100_000;
export const MAX_RESPONSE_SAMPLES_BOUND = 1_000_000;

/**
 * The redirect ceiling `apply_request_fields` clamps a stored request to
 * (`std::clamp (r.max_redirects, 0, 100)`). `POST /runs` has no guard of its
 * own - the field reaches `CURLOPT_MAXREDIRS` as an `int`, where a negative
 * means *unlimited* - so this schema is the only thing between an agent's
 * `maxRedirects: -1` and a run that follows redirect chains forever. Refused
 * rather than clamped, like every other bound here: a value silently changed is
 * a run measuring something the agent did not ask for.
 *
 * Read by both surfaces that take the field - `requestSettingsInput`, which
 * writes it onto a saved request (issue #759), and `start_load_run`, which lays
 * it over a composed payload (#760) - so the two cannot come to disagree about
 * what the engine accepts.
 */
export const MAX_REDIRECTS_BOUND = 100;

/**
 * The recording knobs of a load run, as `{tool argument: run config key}`. Two
 * spellings because the engine's are snake_case here and only here -
 * `success_sample_rate` and `response_sample_rate` are not rates but *periods*
 * (keep 1 in N), and the app's own `StartLoadTestRequest` carries a comment
 * saying so. The argument is named for what the value means; the payload key
 * stays the engine's, so `get_run_report`'s echo of the config snapshot matches
 * what a run was started with. The load dialog sends the first three of these
 * and neither response-sample key (#2447), so only an agent ever changes the
 * samples `get_run_samples` reads.
 */
const LOAD_RECORDING_FIELDS: ReadonlyArray<[argument: string, configKey: string]> = [
	["successSamplePeriod", "success_sample_rate"],
	["slowRequestThresholdMs", "slow_threshold_ms"],
	["saveTimingBreakdown", "save_timing_breakdown"],
	["responseSamplePeriod", "response_sample_rate"],
	["maxResponseSamples", "max_response_samples"],
];

/**
 * Copy the recording knobs and the run comment onto a `POST /runs` payload.
 *
 * Shared by both load paths because both read them: a scenario load run is
 * driven by the same `RunContext`, whose constructor is the one place
 * `success_sample_rate` / `save_timing_breakdown` / `slow_threshold_ms` and the
 * two response-sample keys are read (`core/run_manager.cpp`), and `comment` is lifted into the run summary
 * and the report's `metadata.configuration` by `routes/runs.cpp` whichever
 * executor produced the run. Forwarding them on one path only would have been a
 * knob that silently did nothing on the other.
 *
 * Absent stays absent - never defaulted - because each of these has an engine
 * default a stated value would overwrite, and "the caller said nothing" and
 * "the caller asked for the default" are the same run only by accident.
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
 * Copy the default-header opt-outs onto an execute or run payload (issue #1337).
 *
 * Beside the composed payload rather than through composition, for the reason
 * `data` is: composition resolves `{{variables}}` and the auth chain, and an
 * opt-out is neither - it is a send-time fact about the engine's own defaults,
 * never stored on a request and never interpolated. `POST /execute` and
 * `POST /runs` read it off the payload they are given.
 *
 * Absent stays absent: an empty list and no list say the same thing to the
 * engine, and sending one where the agent named none would be this layer
 * making a claim on its behalf.
 */
export function applyDefaultHeaderOptOuts(
	args: Record<string, unknown>,
	payload: Record<string, unknown>
): void {
	const names = args.disabledDefaultHeaders;
	if (Array.isArray(names)) payload.disabledDefaultHeaders = names;
}
