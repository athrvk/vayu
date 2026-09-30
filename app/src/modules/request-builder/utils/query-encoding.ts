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

/**
 * Which part of a URL a point in its text sits in (issue #1773), the engine's
 * `core::UrlComponent`: `head` is the scheme, host and path.
 */
export type UrlComponent = "head" | QueryPart | "fragment";

/**
 * The component in force after `text`, read from `from`: the first `?` opens
 * the query at a key, `=` moves a key to its value, `&` starts the next key,
 * `#` opens the fragment. A whole `{{...}}` token moves nothing.
 */
export function advanceUrlComponent(text: string, from: UrlComponent): UrlComponent {
	let where = from;
	for (let at = 0; at < text.length && where !== "fragment";) {
		const end = tokenEnd(text, at);
		if (end !== -1) {
			at = end;
			continue;
		}
		const char = text[at++];
		if (char === "#") where = "fragment";
		else if (where === "head") where = char === "?" ? "key" : where;
		else if (char === "&") where = "key";
		else if (char === "=" && where === "key") where = "value";
	}
	return where;
}

/**
 * `url` with each `{{...}}` token resolved through `resolve` and written by the
 * rule of the component it lands in, the engine's `substitute_url_tokens`: a
 * query key or value by `encodeQueryComponent`, the head and the fragment as
 * resolved. `resolve` gets the token alone, so a layered value is resolved
 * whole and encoded once. `encode: false` is `disableUrlEncoding`.
 */
export function resolveUrlTemplate(
	url: string,
	resolve: (text: string) => string,
	{ encode }: { encode: boolean }
): string {
	if (!encode) return resolve(url);
	let out = "";
	let where: UrlComponent = "head";
	let plain = 0;
	for (let at = 0; at < url.length;) {
		const end = tokenEnd(url, at);
		if (end === -1) {
			at++;
			continue;
		}
		const literal = url.slice(plain, at);
		where = advanceUrlComponent(literal, where);
		const resolved = resolve(url.slice(at, end));
		const written =
			where === "key" || where === "value" ? encodeQueryComponent(resolved, where) : resolved;
		where = advanceUrlComponent(written, where);
		out += literal + written;
		plain = at = end;
	}
	return out + url.slice(plain);
}
