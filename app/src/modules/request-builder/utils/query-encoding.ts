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
 * `core::UrlComponent`: `head` is the scheme, host and path. A query key and
 * value are one component: substituted text encodes both alike.
 */
export type UrlComponent = "head" | "query" | "fragment";

/** `QUERY_ENCODE_SET`'s ASCII beyond the controls; its `#` is structure here. */
const SUBSTITUTED_ENCODE_ASCII = new Set([...` "'<>`].map((char) => char.charCodeAt(0)));

function afterUrlChar(char: string, where: UrlComponent): UrlComponent {
	if (char === "#") return "fragment";
	return char === "?" && where === "head" ? "query" : where;
}

/**
 * The component in force after `text`, read from `from`: the first `?` in the
 * head opens the query, `#` opens the fragment. A whole `{{...}}` token moves
 * nothing.
 */
export function advanceUrlComponent(text: string, from: UrlComponent): UrlComponent {
	let where = from;
	for (let at = 0; at < text.length && where !== "fragment";) {
		const end = tokenEnd(text, at);
		if (end !== -1) {
			at = end;
			continue;
		}
		where = afterUrlChar(text[at++], where);
	}
	return where;
}

/**
 * `value` written into a URL at `from`, and the component it leaves the URL
 * in: the engine's `encode_at_url_component`. Postman substitutes into the URL
 * string and parses it again, so a value is URL text: its `?` opens the query
 * from the head, its `#` the fragment, its `&` and `=` split pairs, and only
 * `QUERY_ENCODE_SET` is encoded in the query. The head and the fragment are
 * written as they stand; a whole `{{...}}` token is kept and moves nothing.
 */
export function encodeAtUrlComponent(
	value: string,
	from: UrlComponent
): { written: string; where: UrlComponent } {
	let where = from;
	let out = "";
	for (let at = 0; at < value.length;) {
		const end = tokenEnd(value, at);
		if (end !== -1) {
			out += value.slice(at, end);
			at = end;
			continue;
		}
		// A whole code point, so a character outside the BMP encodes as its
		// UTF-8 bytes rather than as two lone surrogates.
		const char = String.fromCodePoint(value.codePointAt(at) ?? 0);
		at += char.length;
		where = afterUrlChar(char, where);
		out += where === "query" ? percentEncodeQuery(char, SUBSTITUTED_ENCODE_ASCII) : char;
	}
	return { written: out, where };
}

/**
 * `url` with each `{{...}}` token resolved through `resolve` and written as
 * URL text at the component the text before it has reached, substituted
 * values included: the engine's `substitute_url_tokens`. `resolve` gets the
 * token alone, so a layered value is resolved whole and encoded once.
 * `encode: false` is `disableUrlEncoding`.
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
		const encoded = encodeAtUrlComponent(resolve(url.slice(at, end)), where);
		where = encoded.where;
		out += literal + encoded.written;
		plain = at = end;
	}
	return out + url.slice(plain);
}
