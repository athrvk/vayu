/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning the response on screen into a stored example (issue #588).
 *
 * Kept out of the dialog because this is the part with a contract: what an
 * app-saved example holds has to match what an importer would have written for
 * the same response, or the mock server would answer differently depending on
 * where its route table came from. The two rules that could drift are both
 * here - the Content-Type lookup is the Postman importer's, header for header
 * (`importers/postman.ts`), and `order` is never sent so the engine appends.
 */

import type { CreateRequestExampleRequest, KeyValueEntry } from "@/types";
import type { ResponseState } from "../../types";

/**
 * Appended to the default name when the stored body is only the first slice of
 * the response (`maxTraceBodyBytes` on a restored run).
 *
 * A saved example is served by the mock as though it were a whole response, so
 * a partial one has to say so somewhere that survives the save. The dialog's
 * warning explains it; this is the part that stays on the row afterwards - the
 * name is the only field the panel lists, and the engine has no truncation
 * column of its own to carry the fact.
 */
export const TRUNCATED_NAME_SUFFIX = " (truncated body)";

/**
 * The name a save starts with: the status line, which is what a saved response
 * is usually called and is unique enough to tell two of them apart at a glance.
 *
 * Editable at save time - this is a starting point, not a scheme.
 */
export function defaultExampleName(response: ResponseState): string {
	const base = response.statusText
		? `${response.status} ${response.statusText}`
		: String(response.status);
	return response.bodyTruncated ? `${base}${TRUNCATED_NAME_SUFFIX}` : base;
}

/** The response's headers as stored entries, in the order they are held. */
function headerEntries(headers: Record<string, string>): KeyValueEntry[] {
	return Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true }));
}

/**
 * The create payload for @p response under @p name.
 *
 * `contentType` is the response's own Content-Type header verbatim, looked up
 * case-insensitively - the same rule and the same "" fallback the Postman
 * importer uses, rather than a media type parsed out of it. The engine
 * denormalizes this column for the mock server, and a value that disagrees with
 * the header beside it is the kind of difference that only shows up when
 * something is served.
 */
export function exampleFromResponse(
	response: ResponseState,
	name: string
): CreateRequestExampleRequest {
	const headers = headerEntries(response.headers);
	return {
		name,
		status: response.status,
		headers,
		body: response.body,
		contentType: headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "",
		// Always `user`: this is the field a spec sync reads to know it must
		// leave the row alone (#627). An app-saved example is never a spec's.
		origin: "user",
	};
}
