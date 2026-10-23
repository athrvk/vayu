/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file failure.ts
 * @brief The one failure-mapping layer (#2776): what kind of failure an error
 *        result is, and what it says about it.
 *
 * Every error result is built by `errorResult` (`kit.ts`), which records the
 * class here; `dispatchTool` reads it back once, through
 * {@link describeFailure}, and answers the text beside a machine-readable
 * `structuredContent.error`. The class table in `docs/engine/mcp.md` ("Error
 * results") is this file's.
 */

import type { EngineRequestError } from "../engine-client.js";
import type { RetryAdvice, ToolResult } from "./contract.js";

/**
 * What kind of failure an error result is, which decides what an agent does
 * next: ask the user (`policy`), change the arguments (`input`, `not_found`),
 * or call again (`transient`, `unreachable`).
 */
export type FailureClass = "policy" | "input" | "transient" | "not_found" | "unreachable";

/** Whether the same call, repeated unchanged, can succeed. */
const RETRYABLE: Readonly<Record<FailureClass, boolean>> = {
	policy: false,
	input: false,
	not_found: false,
	transient: true,
	unreachable: true,
};

/**
 * A call that stopped before the engine answered and may have taken effect
 * (#2777). The sentences around the advice, which depends on the tool and so is
 * written by {@link describeFailure}, not by the site that saw the error.
 */
export interface Interrupted {
	lead: string;
	tail?: string;
}

/** What an error result was built from: its class and the sentence the tool wrote. */
export interface Failure {
	failureClass: FailureClass;
	/** Complete on its own: for a reader with no tool in hand, the generic advice. */
	message: string;
	interrupted?: Interrupted;
}

/** What to do about a call that may have completed, for a tool that declared nothing. */
const GENERIC_INTERRUPTED_ADVICE =
	"It may still have completed the call - check run history (list_runs) before retrying.";

function interruptedAdvice(retry: RetryAdvice | undefined): string {
	if (retry === "safe") return "Repeating the call is safe.";
	if (typeof retry === "object") {
		return (
			`The call may have completed: call ${retry.check}, find the ${retry.noun}, ` +
			`and do not retry blindly - a retry creates a second ${retry.noun}.`
		);
	}
	return GENERIC_INTERRUPTED_ADVICE;
}

function interruptedText({ lead, tail }: Interrupted, retry: RetryAdvice | undefined): string {
	return [lead, interruptedAdvice(retry), tail].filter(Boolean).join(" ");
}

/**
 * A transient failure for a call that stopped before the engine answered. Its
 * `message` carries the generic advice; {@link describeFailure} swaps in the
 * tool's own.
 */
export function interruptedFailure(lead: string, tail?: string): Failure {
	const interrupted = { lead, tail };
	return {
		failureClass: "transient",
		message: interruptedText(interrupted, undefined),
		interrupted,
	};
}

/**
 * The failure each error result stands for, keyed by the result.
 *
 * A WeakMap for the reason `NOTHING_CHANGED` is a WeakSet: the result object is
 * handed to the SDK verbatim (`server.ts`), so a field here would be serialized
 * to the client as though it were part of the MCP result shape. A result built
 * by spreading another one is a new key, so a helper that does that
 * (`withCaveat`) carries the entry across.
 */
export const FAILURES = new WeakMap<ToolResult, Failure>();

/** An error result's `structuredContent.error`. */
export interface FailureDetail {
	class: FailureClass;
	retryable: boolean;
	advice: string;
}

/** What an error result answers: its text, and the same failure for a machine. */
export interface FailureDescription {
	text: string;
	error: FailureDetail;
}

/**
 * What the client reads for @p failure. The one place a failure becomes words,
 * so wording one per class or per tool is a change to this function alone.
 * @p retry is the tool's declared advice for an interrupted call.
 */
export function describeFailure(failure: Failure, retry?: RetryAdvice): FailureDescription {
	const text = failure.interrupted
		? interruptedText(failure.interrupted, retry)
		: failure.message;
	return {
		text,
		error: {
			class: failure.failureClass,
			retryable: RETRYABLE[failure.failureClass],
			advice: text,
		},
	};
}

/**
 * The engine's busy-database sentence (`send_exception`, `routes.hpp`). A 503
 * is not enough to match on: the engine also answers 503 while it is shutting
 * down, where a retry is wrong, and both carry the code `unavailable`.
 */
const BUSY_DATABASE = /database is busy/i;

export function isBusyDatabase(err: EngineRequestError): boolean {
	return err.status === 503 && BUSY_DATABASE.test(err.body);
}

/**
 * The class of an HTTP refusal the engine answered. A 409 (the id exists, the
 * spec is still bound, the restore needs its parent first) and a 413 are
 * verdicts on what the call asked for, as a 400 is. A 507 (disk full) and a
 * busy database are worth repeating once the cause clears, as any other 5xx
 * is; the 503 an engine answers while shutting down is not, until it runs
 * again, which is what `unreachable` says.
 */
export function engineRefusalClass(err: EngineRequestError): FailureClass {
	if (err.status === 403) return "policy";
	if (err.status === 404) return "not_found";
	if (err.status === 503 && !isBusyDatabase(err)) return "unreachable";
	if (err.status >= 500) return "transient";
	return "input";
}

/**
 * The SDK's refusal of a call's arguments, before any handler runs
 * (`validateToolInput`, @modelcontextprotocol/server): a schema failure, or
 * more argument elements than the server accepts.
 */
const SDK_INPUT_REFUSAL = /^(Input validation error|Invalid arguments for tool)/;

/**
 * The class of an error the SDK answered itself, which never reached
 * `dispatchTool`. Its argument check is `input`; anything else it catches (an
 * answer its output check refused) is this server's fault, not the call's.
 */
export function sdkErrorClass(text: string): FailureClass {
	return SDK_INPUT_REFUSAL.test(text) ? "input" : "transient";
}
