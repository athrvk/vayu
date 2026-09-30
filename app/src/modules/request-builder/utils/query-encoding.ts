/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Postman's query encoding (issue #1771): how one key or value of a query row
 * is written into the URL, the engine's `encode_query_component`
 * (`engine/src/core/query_encoding.cpp`), pinned to it by
 * `engine/tests/fixtures/query-encoding-conformance.json`.
 *
 * Postman's `toNodeUrl` joins the rows with `QueryParam.unparse` and encodes
 * the result with `postman-url-encoder`'s `QUERY_ENCODE_SET`: the C0 controls,
 * DEL, every byte above `~` (per UTF-8 byte), and space `"` `#` `'` `<` `>`.
 * `unparseSingle` has already encoded `&` (and `#`) in both parts and `=` in a
 * key only, so `=` in a value goes out raw. `%` is never encoded: a `%XX`
 * passes through, and so does a lone `%`. A whole `{{...}}` token is kept.
 */

import { tokenEnd } from "./path-variables";

/** Which side of `key=value` a component is: only a key encodes `=`. */
export type QueryPart = "key" | "value";

const encoder = new TextEncoder();

/** `QUERY_ENCODE_SET`'s ASCII beyond the controls, plus `unparseSingle`'s `&`. */
const VALUE_ENCODE_ASCII = new Set([...` "#'<>&`].map((char) => char.charCodeAt(0)));
const KEY_ENCODE_ASCII = new Set([...VALUE_ENCODE_ASCII, "=".charCodeAt(0)]);

function percentEncodeQuery(text: string, ascii: ReadonlySet<number>): string {
	let out = "";
	for (const byte of encoder.encode(text)) {
		out +=
			byte < 0x20 || byte > 0x7e || ascii.has(byte)
				? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
				: String.fromCharCode(byte);
	}
	return out;
}

/** `text` as Postman writes it into a query as a key or a value. */
export function encodeQueryComponent(text: string, part: QueryPart): string {
	const ascii = part === "key" ? KEY_ENCODE_ASCII : VALUE_ENCODE_ASCII;
	let out = "";
	let plain = 0;
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end === -1) {
			at++;
			continue;
		}
		out += percentEncodeQuery(text.slice(plain, at), ascii) + text.slice(at, end);
		plain = at = end;
	}
	return out + percentEncodeQuery(text.slice(plain), ascii);
}
