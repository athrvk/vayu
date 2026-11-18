/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Console row's request as a cURL command (#3634), built from what the row
 * holds: its masked URL and header values, so the copy carries `<redacted>`
 * wherever the row does and never a credential the row no longer has.
 *
 * Through `generateCurl`, the app's one cURL writer, with two of its inputs
 * pinned. `disableUrlEncoding` because the URL is the one that was sent:
 * encoding it again would turn the marker into `%3Credacted%3E`. Masking stays
 * off, because the row is already masked and the codegen masker has no secret
 * values to look for here.
 */

import { generateCurl } from "@/services/codegen/curl";
import type { ConsoleScriptRequestRow, ConsoleSendRow } from "@/stores/console-store";

/** The rows that hold the request they sent. A step's request is on its stored row. */
export type ConsoleCurlRow = ConsoleSendRow | ConsoleScriptRequestRow;

export function consoleRowCurl(row: ConsoleCurlRow): string {
	const body = row.exchange.requestBody;
	return generateCurl({
		method: row.method || "GET",
		url: row.url,
		headers: row.exchange.requestHeaders,
		// A request body is recorded as text; a base64 one would be bytes the
		// command cannot carry as `--data-raw`.
		body: body && !body.base64 ? body.text : undefined,
		disableUrlEncoding: true,
	}).code;
}

/** Whether the copied command carries less body than was sent, for the action's tooltip. */
export function curlBodyIsCut(row: ConsoleCurlRow): boolean {
	return row.exchange.requestBody?.cut === true;
}
