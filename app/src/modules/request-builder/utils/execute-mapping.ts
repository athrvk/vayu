/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two pure ends of the execute pipeline: editor state to the body the
 * engine takes, and the engine's result back to the response pane's state.
 *
 * Both were inline in `request-builder/index.tsx` and then copied wholesale
 * into the History run view when it grew its own send path. That is the
 * "hand-rolled copy does not receive the primitive's fixes" trap - the copies
 * had already drifted cosmetically before anyone read them side by side. The
 * body branches and the ~20-field response mapping are pure functions of their
 * inputs, so they live here and both callers use them.
 *
 * Deliberately *not* moved: auth resolution (already shared via
 * `auth-resolution.ts`), the script-part list (each caller builds a different one -
 * the builder walks the live collection chain, the run view replays what was
 * recorded), and the header/URL resolution, which differs in which variables
 * are in scope.
 */

import type { SanityResult, ScriptPart } from "@/types";
import type { RequestState, ResponseState } from "../types";
import { toKeyValueEntries } from "./key-value";

/** The body shape `POST /request` and `POST /run` accept. */
export interface ExecBody {
	mode: string;
	content?: string;
	fields?: Array<{ key: string; value: string; enabled: boolean }>;
}

/**
 * Build the outgoing body from the flat editor fields, resolving `{{vars}}` on
 * the way. Returns `undefined` for a request that carries no body, so the field
 * is omitted rather than sent as an empty object.
 *
 * The two field-based modes resolve each key and value individually; the
 * content-based modes resolve the whole string. `mode: "none"` and an empty
 * body both mean "no body".
 */
export function buildExecBody(
	request: RequestState,
	resolveString: (input: string) => string
): ExecBody | undefined {
	if (request.bodyMode === "form-data") {
		return {
			mode: "form-data",
			fields: toKeyValueEntries(request.formData).map((e) => ({
				key: resolveString(e.key),
				value: resolveString(e.value),
				enabled: e.enabled,
			})),
		};
	}

	if (request.bodyMode === "x-www-form-urlencoded") {
		return {
			mode: "x-www-form-urlencoded",
			fields: toKeyValueEntries(request.urlEncoded).map((e) => ({
				key: resolveString(e.key),
				value: resolveString(e.value),
				enabled: e.enabled,
			})),
		};
	}

	const resolvedBody = request.body ? resolveString(request.body) : request.body;
	if (request.bodyMode !== "none" && resolvedBody) {
		return { mode: request.bodyMode || "text", content: resolvedBody };
	}

	return undefined;
}

/**
 * The identity fields the engine hands the script sandbox as `pm.info`, for
 * the inline half of the compose payload (issue #300).
 *
 * Only the name lives here: `requestId` is attached at execute time by each
 * caller, because the two disagree about where it comes from - the builder
 * sends the saved row's id, the run view sends the id the run was filed under -
 * while both mean the same thing by "the name in the editor right now".
 *
 * It has to come from the client at all because Send executes editor state: an
 * unsaved request has a name and no row to look it up in, and a detached
 * replay copy has a name that is not the stored one. An empty name is omitted
 * rather than sent as `""`, so a script reads `undefined` and its `typeof`
 * check answers truthfully.
 */
export function execIdentity(request: RequestState): { requestName?: string } {
	return request.name ? { requestName: request.name } : {};
}

/** Sniff the render mode from the response's content type. */
function bodyTypeFromContentType(headers: Record<string, string> | undefined) {
	const contentType = (headers?.["content-type"] || "").toLowerCase();
	if (contentType.includes("json")) return "json" as const;
	if (contentType.includes("html")) return "html" as const;
	if (contentType.includes("xml")) return "xml" as const;
	return "text" as const;
}

/**
 * Map an engine execute result onto the response pane's state.
 *
 * Two subtleties worth keeping:
 *
 * - **status 0 is meaningful**, so it must not be defaulted to 200. It is what
 *   a client-side failure (no server response) reports, and it is what makes
 *   the pane render `ClientErrorView` instead of an empty 200.
 * - **`typeof null === "object"`**, so the body checks test for null
 *   explicitly. Without that a JSON `null` body stringifies as `"null"` in one
 *   branch and vanishes in the other.
 *
 * `bodyRaw` is always carried through for the Raw view; `body` prefers the
 * parsed form and falls back to it.
 */
export function responseFromExecuteResult(result: SanityResult): ResponseState {
	/*
	 * The fallback must not indent. `bodyRaw` is the field whose entire job is
	 * to be what the server actually sent - the Raw view reads it and nothing
	 * else - so a fallback that pretty-prints turns Raw into a second Pretty
	 * whenever it fires.
	 *
	 * The engine always sends `bodyRaw` (`json["bodyRaw"] = response.body` in
	 * `utils/json.cpp`), so this is a guard against a producer that does not,
	 * and the original bytes are already gone by the time we are stringifying a
	 * parsed object. Compact is the closest honest reconstruction; indenting
	 * would be inventing formatting the server never sent.
	 */
	const bodyRaw =
		result.bodyRaw ||
		(typeof result.body === "object" && result.body !== null
			? JSON.stringify(result.body)
			: String(result.body || ""));

	const body =
		typeof result.body === "object" && result.body !== null
			? JSON.stringify(result.body, null, 2)
			: result.body !== null && result.body !== undefined
				? String(result.body)
				: bodyRaw || "";

	return {
		status: result.status !== undefined && result.status !== null ? result.status : 200,
		statusText: result.statusText || "",
		headers: result.headers || {},
		requestHeaders: result.requestHeaders,
		rawRequest: result.rawRequest,
		httpVersion: result.httpVersion,
		httpVersionDowngraded: result.httpVersionDowngraded,
		body,
		bodyRaw,
		bodyType: bodyTypeFromContentType(result.headers),
		// When it arrived, as opposed to how long it took. The status bar shows
		// it as an age, which is the only thing distinguishing a fresh response
		// from one sent before the request beside it was edited.
		receivedAt: new Date().toISOString(),
		time: result.timing?.totalMs || 0,
		timing: result.timing,
		size: result.bodySize || 0,
		errorCode: result.errorCode,
		errorMessage: result.errorMessage,
		consoleLogs: result.consoleLogs,
		testResults: result.testResults,
		preScriptError: result.preScriptError,
		postScriptError: result.postScriptError,
	};
}

/**
 * Whether an execute that ran these script parts could have written a variable
 * the UI is showing, and so needs the environment/globals/collection caches
 * invalidated.
 *
 * Both kinds count. The gate used to read `if (preScriptParts)` at both call
 * sites, which is the same "copy that never receives the fix" trap this module
 * exists to close: `pm.environment.set` / `pm.globals.set` /
 * `pm.collectionVariables.set` persist engine-side from a post-request (Tests
 * tab) script exactly as they do from a pre-request one, so a request whose
 * only script was in the Tests tab stored the value while the variables editor
 * and the resolver kept showing the old one - `refetchOnWindowFocus` is off, so
 * nothing else was coming to correct it.
 *
 * Empty part lists are treated as no script, matching what the call sites'
 * truthiness checks already did with `undefined`.
 */
export function scriptsMayWriteVariables(
	preScriptParts?: ScriptPart[],
	postScriptParts?: ScriptPart[]
): boolean {
	return Boolean(preScriptParts?.length) || Boolean(postScriptParts?.length);
}
