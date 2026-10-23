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
import type { ToolResult } from "./contract.js";

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

/** What an error result was built from: its class and the sentence the tool wrote. */
export interface Failure {
	failureClass: FailureClass;
	message: string;
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
 */
export function describeFailure(failure: Failure): FailureDescription {
	return {
		text: failure.message,
		error: {
			class: failure.failureClass,
			retryable: RETRYABLE[failure.failureClass],
			advice: failure.message,
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
