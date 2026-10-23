/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file kit.ts
 * @brief The helpers every tool shares: result builders, argument coercion and
 *        the write and confirmation gates.
 *
 * The bottom of the `tools/` import graph beside `contract.ts`: a section file
 * may import from here and this file imports from no section, so a helper two
 * sections need lives here rather than in either of them. `NOTHING_CHANGED`,
 * `STARTED_RUNS` and `INPUT_REQUIRED` are module state the dispatch path reads after a handler
 * returns; they are defined here and nowhere else, so the handlers that mark a
 * result and the dispatcher that reads the mark share one instance.
 */

import { z } from "zod";
import {
	acceptedContent,
	inputRequired,
	inputResponse,
	type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { EngineRequestError, EngineTimeoutError } from "../engine-client.js";
import { presentCollection } from "../collection-shape.js";
import { engineDownRemedy, settingRemedy } from "../remedy.js";
import { targetPolicyRefusalOfErrorBody, type GuardResult } from "../safety.js";
import { runOutputShape, secretsShape, withholdRowSecrets } from "../withhold.js";
import type { StartedRun, ToolContext, ToolResult } from "./contract.js";
import {
	engineRefusalClass,
	FAILURES,
	interruptedFailure,
	isBusyDatabase,
	type Failure,
	type FailureClass,
} from "./failure.js";

// --- Result helpers ----------------------------------------------------------

export function jsonResult(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Result that carries both a text rendering and structured content. */
export function structuredResult(value: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
		structuredContent: value,
	};
}

/**
 * @p answer as the object a `structuredContent` must be. A non-object answer is
 * wrapped as `{ raw }` rather than returned bare: a declared `outputSchema` is
 * object-rooted, and the SDK reports a result it rejects as a broken tool while
 * hiding the body the engine actually sent (the case `get_engine_health` pins).
 */
export function structuredRoot(answer: unknown): Record<string, unknown> {
	return isRecord(answer) ? answer : { raw: answer ?? null };
}

export function textResult(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * The one builder of an error result. @p failureClass is required rather than
 * guessed from the wording: the class is what an agent acts on, and a default
 * would hand every site that forgot one a class it did not choose.
 */
export function errorResult(message: string, failureClass: FailureClass): ToolResult {
	return failureResult({ failureClass, message });
}

/** An error result for a {@link Failure} built elsewhere, its marker intact. */
function failureResult(failure: Failure): ToolResult {
	const result: ToolResult = {
		content: [{ type: "text", text: failure.message }],
		isError: true,
	};
	FAILURES.set(result, failure);
	return result;
}

/**
 * The tool error for a guard that refused, in the class the guard gave it. A
 * guard that named none is a safety rule, which is what a guard is for.
 */
export function guardErrorResult(gate: GuardResult, lead = ""): ToolResult {
	return errorResult(`${lead}${gate.error ?? ""}`, gate.failureClass ?? "policy");
}

/**
 * Append a note to a result's text without disturbing its structured content.
 * For telling an agent what a call could *not* do - a caveat printed nowhere is
 * the same as not having noticed it.
 */
export function withCaveat(result: ToolResult, caveat: string): ToolResult {
	if (!caveat) return result;
	const noted = {
		...result,
		content: [...result.content, { type: "text" as const, text: caveat.trimStart() }],
	};
	const failure = FAILURES.get(result);
	if (failure) FAILURES.set(noted, failure);
	return noted;
}

/**
 * What an agent should do about the two answers the engine gives a storage
 * failure (#2423). Neither is a verdict on the arguments, which a 400 would be,
 * so the call is worth repeating unchanged once the cause clears. The body
 * already names the cause; this adds only the action.
 */
function retryHint(err: EngineRequestError): string {
	if (err.status === 507) return " Retry the call after space is freed.";
	if (isBusyDatabase(err)) return " Retry the call in a moment.";
	return "";
}

export function engineErrorResult(err: unknown, ctx: ToolContext): ToolResult {
	return failureResult(engineFailure(err, ctx));
}

/**
 * What a failed engine call says and how it is classed, for a site that words
 * its own error around the cause but keeps the cause's class.
 */
export function engineFailure(err: unknown, ctx: ToolContext): Failure {
	if (err instanceof EngineRequestError) return engineRefusal(err, ctx);
	const msg = err instanceof Error ? err.message : String(err);
	// An abort means the engine was reachable and working - the opposite of the
	// "not running, retry" advice below. Whatever was in flight may well have
	// completed engine-side, so say so instead of inviting a second send. What
	// to check first depends on the tool, so `describeFailure` writes that part.
	if (err instanceof EngineTimeoutError) {
		return interruptedFailure(
			`The engine did not answer within this client's ${Math.round(err.timeoutMs / 1000)}s budget.`,
			`For a target that is legitimately this slow, raise the engine's "defaultTimeout" ` +
				`with update_engine_config.`
		);
	}
	if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(msg))) {
		return interruptedFailure(`The call was cancelled before the engine answered.`, `(${msg})`);
	}
	if (/ECONNREFUSED|fetch failed/i.test(msg)) {
		return {
			message: `Could not reach the Vayu engine. ${engineDownRemedy(ctx.host)}, then retry. (${msg})`,
			failureClass: "unreachable",
		};
	}
	// Nothing above names it (a reset socket, a body that would not parse), and
	// nothing says the call was wrong, so it is worth one more try.
	return { message: `Unexpected error: ${msg}`, failureClass: "transient" };
}

/** An HTTP refusal the engine answered. */
function engineRefusal(err: EngineRequestError, ctx: ToolContext): Failure {
	// A streaming send refuses its final URL before the stream opens (#2521).
	const refused = targetPolicyRefusalOfErrorBody(err.body, ctx.host);
	if (refused) return { message: refused, failureClass: "policy" };
	return {
		message: `Engine error (${err.status}): ${err.body || err.message}${retryHint(err)}`,
		failureClass: engineRefusalClass(err),
	};
}

/**
 * Wrap an engine call so transport errors surface as tool errors, not crashes.
 *
 * `shape` runs on the engine's answer before it becomes a result - the one seam
 * where a passthrough tool can bound what it hands an agent (issue #767).
 */
export function callEngine(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	shape?: (value: unknown) => unknown
): Promise<ToolResult> {
	return callEngineAs(ctx, fn, shape, jsonResult);
}

/**
 * {@link callEngine} for a tool that declares an `outputSchema`: the answer
 * also rides as `structuredContent`, through {@link structuredRoot}.
 */
export function callEngineStructured(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	shape?: (value: unknown) => unknown
): Promise<ToolResult> {
	return callEngineAs(ctx, fn, shape, (value) => structuredResult(structuredRoot(value)));
}

async function callEngineAs(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	shape: ((value: unknown) => unknown) | undefined,
	render: (value: unknown) => ToolResult
): Promise<ToolResult> {
	try {
		const answer = await fn();
		return render(shape ? shape(answer) : answer);
	} catch (err) {
		return engineErrorResult(err, ctx);
	}
}

/**
 * `callEngine`'s `shape` for a write tool that echoes the stored row: withheld
 * exactly as the read of that row is, because writing does not grant reading
 * (#1809). A tool whose answer is a collection row also presents it as
 * `list_collections` does with `fields: "full"`.
 */
export function echoShape(ctx: ToolContext): (row: unknown) => unknown {
	return secretsShape(ctx, withholdRowSecrets);
}

export function collectionEchoShape(ctx: ToolContext): (row: unknown) => unknown {
	return (row) => echoShape(ctx)(presentCollection(row, ctx));
}

/**
 * {@link callEngine} for what a run recorded: the answer withheld by
 * {@link runOutputShape} first and only then bounded, because a cut through an
 * unmasked secret leaves a prefix no form matches (#1809). The projection is
 * read once the engine has answered, so a secret the call itself wrote - a
 * pre-request script's `pm.environment.set` - is among the values masked.
 */
export async function callEngineForRunOutput(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	options: RunOutputOptions = {}
): Promise<ToolResult> {
	return withheldRunAnswer(ctx, fn, options, (withheld) => {
		const bounded = options.bound ? options.bound(withheld) : withheld;
		return options.structured ? structuredResult(structuredRoot(bounded)) : jsonResult(bounded);
	});
}

/**
 * {@link callEngineForRunOutput} for a call whose answer is already a document
 * - Markdown, or JSON the engine serialized - handed to the agent as it is
 * rather than wrapped in a second JSON layer. The text is masked by the same
 * projection: every secret form is replaced wherever it falls in the string.
 */
export async function callEngineForRunText(
	ctx: ToolContext,
	fn: () => Promise<string>,
	options: Pick<RunOutputOptions, "signal" | "auth"> = {}
): Promise<ToolResult> {
	return withheldRunAnswer(ctx, fn, options, (withheld) => textResult(String(withheld)));
}

interface RunOutputOptions {
	bound?: (value: unknown) => unknown;
	/**
	 * The tool error an answer stands for, or undefined to render it: an
	 * engine target-policy refusal this server has a remedy for
	 * (`targetPolicyRefusal`), answered as a `policy` failure.
	 */
	refusal?: (answer: unknown) => string | undefined;
	/** The tool declares an `outputSchema`: answer as {@link callEngineStructured} does. */
	structured?: boolean;
	signal?: AbortSignal;
	/** An auth block sent inline, whose API-key header no stored row names. */
	auth?: unknown;
}

async function withheldRunAnswer(
	ctx: ToolContext,
	fn: () => Promise<unknown>,
	options: Pick<RunOutputOptions, "signal" | "auth" | "refusal">,
	render: (withheld: unknown) => ToolResult
): Promise<ToolResult> {
	let answer: unknown;
	try {
		answer = await fn();
	} catch (err) {
		return engineErrorResult(err, ctx);
	}
	const refused = options.refusal?.(answer);
	if (refused) return errorResult(refused, "policy");
	const withhold = await runOutputShape(ctx, options.signal, [options.auth]);
	return render(withhold(answer));
}

// --- Argument coercion helpers ----------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	return typeof v === "string" ? v : undefined;
}

/** An optional number argument, absent when the caller stated nothing. */
export function num(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	return typeof v === "number" ? v : undefined;
}

/** An optional boolean argument, absent when the caller stated nothing. */
export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
	const v = args[key];
	return typeof v === "boolean" ? v : undefined;
}

export function requireStr(args: Record<string, unknown>, key: string): string {
	const v = str(args, key);
	if (v === undefined || v === "") throw new ToolArgError(`"${key}" is required.`);
	return v;
}

/**
 * An optional array-of-strings argument. A non-array, or an array carrying
 * anything but strings, is the caller's mistake rather than an empty selection:
 * silently dropping the bad entries would answer a different question than the
 * one asked and look like the names simply were not defined.
 */
export function stringArray(args: Record<string, unknown>, key: string): string[] | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || v.some((entry) => typeof entry !== "string")) {
		throw new ToolArgError(`"${key}" must be an array of strings.`);
	}
	return v as string[];
}

/**
 * An argument the handler refused, thrown from wherever it was read and
 * answered by `dispatchTool` as an error result of @p failureClass. Most are
 * `input`; a lookup helper that finds no such id throws `not_found`, and a
 * refusal a setting decides throws `policy`.
 */
export class ToolArgError extends Error {
	constructor(
		message: string,
		readonly failureClass: FailureClass = "input"
	) {
		super(message);
	}
}

/**
 * An optional `elements` argument: an array of `{ id?, kind, enabled?, name?,
 * config }` objects (see {@link elementSchema}). The SDK validates a call
 * against the Zod schema before the handler runs, but `dispatchTool` is also
 * called directly (tests, and any future non-SDK transport), so the shape is
 * re-checked here the same defensive way `headers` and `auth` already are -
 * a non-array or an entry with no string `kind` is the caller's mistake
 * rather than an empty list.
 */
export function elementsArg(
	args: Record<string, unknown>,
	key = "elements"
): unknown[] | undefined {
	const v = args[key];
	if (v === undefined) return undefined;
	if (
		!Array.isArray(v) ||
		v.some(
			(entry) =>
				!entry ||
				typeof entry !== "object" ||
				typeof (entry as Record<string, unknown>).kind !== "string"
		)
	) {
		throw new ToolArgError(`"${key}" must be an array of { kind, config } objects.`);
	}
	return v as unknown[];
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
export function optionalPositiveInt(
	args: Record<string, unknown>,
	key: string,
	fallback: number
): number {
	const v = args[key];
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
		throw new ToolArgError(`"${key}" must be a whole number greater than 0.`);
	}
	return v;
}

/**
 * A page size, refused above @p max rather than clamped to it (the #319
 * precedent): an agent that asked for 5000 rows and silently got 500 reads the
 * short page as the whole answer, which is the one failure a bound must not
 * produce.
 */
export function optionalPageLimit(
	args: Record<string, unknown>,
	key: string,
	fallback: number,
	max: number
): number {
	const value = optionalPositiveInt(args, key, fallback);
	if (value > max) {
		throw new ToolArgError(
			`"${key}" must be ${max} or less. Read further rows with "offset" instead.`
		);
	}
	return value;
}

/** A row offset: whole and non-negative, since 0 is the first page. */
export function optionalOffset(args: Record<string, unknown>, key: string): number {
	const v = args[key];
	if (v === undefined || v === null) return 0;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
		throw new ToolArgError(`"${key}" must be a whole number of 0 or more.`);
	}
	return v;
}

/**
 * The refusal a data-mutating tool returns while the write toggle is off, or
 * null when writes are allowed. One wording for the collection / request /
 * environment tools: which of them was called does not change what the user has
 * to do about it, and a copy per tool is a copy per tool to drift.
 * `update_engine_config` keeps its own sentence, which names config.
 */
export function writesDisabled(ctx: ToolContext): ToolResult | null {
	if (ctx.config.allowWrites) return null;
	return errorResult(
		`Writes are disabled. To allow this, ask the user to ${settingRemedy("allowWrites", ctx.host)}.`,
		"policy"
	);
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
export const NOTHING_CHANGED = new WeakSet<ToolResult>();

/** Mark a successful result as having changed nothing (see {@link NOTHING_CHANGED}). */
export function unchanged(result: ToolResult): ToolResult {
	NOTHING_CHANGED.add(result);
	return result;
}

/**
 * Results that started a run the app should watch (#1419), keyed by the run.
 *
 * A WeakMap for the reason {@link NOTHING_CHANGED} is a WeakSet: the result
 * object is handed to the SDK verbatim (`server.ts`), so a field here would be
 * serialized to the client as though it were part of the MCP result shape.
 */
export const STARTED_RUNS = new WeakMap<ToolResult, StartedRun>();

/**
 * Mark a result as having started `kind`'s run, taking the id from the engine's
 * own answer (see {@link STARTED_RUNS}).
 *
 * An answer without a `runId` marks nothing: the engine's 202 body is what says
 * a run exists, and a body shaped some other way is handed back to the agent as
 * it came rather than announced to the renderer as a run to attach to.
 */
export function watchedRun(
	result: ToolResult,
	kind: StartedRun["kind"],
	started: unknown
): ToolResult {
	const runId =
		started && typeof started === "object" && !Array.isArray(started)
			? (started as Record<string, unknown>).runId
			: undefined;
	if (typeof runId === "string" && runId !== "") STARTED_RUNS.set(result, { runId, kind });
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
 * Results that stand for a question to the person rather than an answer
 * (`input_required`), keyed by the question the client is to put to them.
 *
 * A WeakMap for the reason {@link NOTHING_CHANGED} is a WeakSet. The result
 * itself carries the preview text, so a reader that only knows `ToolResult`
 * (a test, the dispatch log) sees what the question is about; `server.ts`
 * answers the SDK with the marked question instead.
 */
export const INPUT_REQUIRED = new WeakMap<ToolResult, InputRequiredResult>();

/** The key the confirmation question travels under, both ways. */
const CONFIRM_KEY = "confirm";

const confirmAnswer = z.object({ proceed: z.boolean() });

/**
 * Ask the human before something destructive, however the client can manage it.
 *
 * Preferred path is a question to the person, put by the client
 * (`ctx.userInput`): the first call returns it as `input_required` and does
 * nothing, and the client calls again carrying the answer. That handler entry
 * is a fresh one, so everything a gated tool does before this gate must be a
 * read. A client that cannot be asked falls back to the agent-side flag: the
 * first call returns a preview and does nothing, and only a second call
 * carrying `confirmed: true` proceeds. Anti-accident rather than
 * anti-adversary (an agent can set the flag itself), which is the same posture
 * `start_load_run` has always had; the question is what upgrades it to a human
 * decision.
 *
 * Returns `null` when the caller may proceed, or the result to return instead.
 */
export async function confirmDestructive(
	args: Record<string, unknown>,
	ctx: ToolContext,
	prompt: ConfirmationPrompt
): Promise<ToolResult | null> {
	if (ctx.userInput) {
		const answer = inputResponse(ctx.userInput.responses, CONFIRM_KEY);
		if (answer.kind === "elicit") {
			const accepted = acceptedContent(ctx.userInput.responses, CONFIRM_KEY, confirmAnswer);
			return answer.action === "accept" && accepted?.proceed === true
				? null
				: unchanged(textResult(prompt.declined));
		}
		const question = unchanged(textResult(prompt.preview));
		INPUT_REQUIRED.set(
			question,
			inputRequired({
				inputRequests: {
					[CONFIRM_KEY]: inputRequired.elicit({
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
					}),
				},
			})
		);
		return question;
	}
	if (args.confirmed !== true) return unchanged(textResult(prompt.preview));
	return null;
}

/** The `confirmed` fallback flag, declared identically on every gated tool. */
export function confirmedInput(action: string) {
	return z
		.boolean()
		.optional()
		.describe(`Fallback confirmation for clients without elicitation: set true to ${action}.`);
}
