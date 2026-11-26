/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning the response on screen into a stored example (#588), apart from the dialog because this
 * part has a contract: an app-saved example must match what an importer writes for the same
 * response, or a mock answers differently by where its routes came from. Both drift-prone rules are
 * here: the Content-Type lookup is the Postman importer's (`importers/postman.ts`), and `order` is
 * never sent, so the engine appends. A live send's response carries the request as sent
 * (`sentRequest`), forwarded as `savedFrom` with the reason phrase and response time (#1763): the
 * engine builds the Postman saved response once, so an export describes the request that produced
 * this response. A response with no matching Send (the last run after a restart, one from History)
 * has no snapshot and sends no `savedFrom`.
 */

import type { CreateRequestExampleRequest, KeyValueEntry } from "@/types";
import { resolveHeaderLines } from "@/lib/header-lines";
import type { ResponseState } from "../../types";
import { receivedBody } from "../../utils/response-bytes";

/**
 * The starting name: the status line, what a saved response is usually called and unique enough to
 * tell two apart. Editable at save; truncation is recorded (`bodyTruncated`, #659) and chipped, so
 * the name is free to be anything.
 */
export function defaultExampleName(response: ResponseState): string {
	return response.statusText
		? `${response.status} ${response.statusText}`
		: String(response.status);
}

/**
 * Why @p response cannot become an example, or nothing. An example body is text, and a body the
 * engine sent as base64 (#2458) is not: its text would be a decoding stored and served as UTF-8
 * under a Content-Type naming the original charset. Refused, not saved as something never sent.
 */
export function exampleRefusal(response: Pick<ResponseState, "rawBytes">): string | undefined {
	return response.rawBytes ? "Examples hold UTF-8 text, and this body isn't" : undefined;
}

/**
 * The response's headers as stored entries, one per line sent, in its case and order (#3422). The
 * folded map joins a repeated name into one lowercased value, so a `Set-Cookie` pair would become
 * one row and a mock would answer with a header never sent; with no recorded lines, the map is the
 * fallback.
 */
function headerEntries(response: ResponseState): KeyValueEntry[] {
	return resolveHeaderLines(response.headers, response.headerLines).map(({ name, value }) => ({
		key: name,
		value,
		enabled: true,
	}));
}

/**
 * The create payload for @p response under @p name. `contentType` is the response's Content-Type
 * header verbatim, found case-insensitively, with the Postman importer's "" fallback, not a parsed
 * media type: the engine denormalizes it for the mock server, and a value disagreeing with the
 * header shows up only when served. `savedFrom` rides only with a Send snapshot (else the engine
 * regenerates on export); its `receivedAt` is when the response arrived, which a cookie's `Max-Age`
 * counts from, not the later Save.
 */
export function exampleFromResponse(
	response: ResponseState,
	name: string
): CreateRequestExampleRequest {
	const headers = headerEntries(response);
	return {
		name,
		status: response.status,
		headers,
		// The text as received, not the indented pane copy: a mock serves it verbatim, keeping the
		// server's key order and digits.
		body: receivedBody(response),
		contentType: headers.find((h) => h.key.toLowerCase() === "content-type")?.value ?? "",
		// Always `user`: a spec sync reads this to leave the row alone (#627).
		origin: "user",
		// Partial either way: stored-run truncation or a read stopped at the Send cap
		// (`bodyCapped`, #3422), neither what the server sent, and a mock serves it as whole.
		// Absent means "not partial", not "unknown", for a response never through a trace.
		bodyTruncated: Boolean(response.bodyTruncated || response.bodyCapped),
		...(response.sentRequest && {
			savedFrom: {
				request: response.sentRequest,
				statusText: response.statusText,
				responseTimeMs: response.time,
				...receivedAtOf(response),
			},
		}),
	};
}

/**
 * When @p response came in, as `savedFrom.receivedAt` (epoch ms): the live funnel's `receivedAt`,
 * else `restoredFrom.at` on a stream's reloaded copy. Nothing when neither parses; the engine then
 * uses its clock.
 */
function receivedAtOf(response: ResponseState): { receivedAt?: number } {
	const at = Date.parse(response.receivedAt ?? response.restoredFrom?.at ?? "");
	return Number.isFinite(at) && at >= 0 ? { receivedAt: at } : {};
}
