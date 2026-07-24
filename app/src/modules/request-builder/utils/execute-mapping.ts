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
 * `auth-mapping.ts`), the script-part list (each caller builds a different one -
 * the builder walks the live collection chain, the run view replays what was
 * recorded), and the header/URL resolution, which differs in which variables
 * are in scope.
 */

import type { SanityResult } from "@/types";
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
	const bodyRaw =
		result.bodyRaw ||
		(typeof result.body === "object" && result.body !== null
			? JSON.stringify(result.body, null, 2)
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
		body,
		bodyRaw,
		bodyType: bodyTypeFromContentType(result.headers),
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
