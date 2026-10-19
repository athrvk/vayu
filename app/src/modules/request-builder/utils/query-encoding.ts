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

import { inPathEncodeSet, tokenEnd } from "./path-variables";

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
 * Which part of a URL a point in its text sits in (issues #1773, #2465), the
 * engine's `core::UrlComponent`. `head` is the scheme and the authority;
 * `headSeparator` is the head just after a `:` or `/`, where a `/` continues a
 * `://` rather than opening the path. A query key and value are one
 * component: substituted text encodes both alike.
 */
export type UrlComponent = "head" | "headSeparator" | "path" | "query" | "fragment";

/** `QUERY_ENCODE_SET`'s ASCII beyond the controls; its `#` is structure here. */
const SUBSTITUTED_ENCODE_ASCII = new Set([...` "'<>`].map((char) => char.charCodeAt(0)));

/** `FRAGMENT_ENCODE_SET`'s ASCII beyond the controls. */
const FRAGMENT_ENCODE_ASCII = new Set([...` "<>\``].map((char) => char.charCodeAt(0)));

/**
 * What no request target may carry raw: the C0 controls, space, DEL and every
 * byte above `~`. Each Postman set contains it.
 */
const isUnsendableByte = (byte: number) => byte <= 0x20 || byte >= 0x7f;

const inHead = (where: UrlComponent) => where === "head" || where === "headSeparator";

/** Where reading `char` at `where` moves the URL: `after_url_byte`. */
function afterUrlChar(char: string, where: UrlComponent): UrlComponent {
	if (char === "#") return "fragment";
	if (where === "query" || where === "fragment") return where;
	if (char === "?") return "query";
	if (where === "path") return where;
	if (char === ":") return "headSeparator";
	if (char === "/") return where === "headSeparator" ? where : "path";
	return "head";
}

/**
 * A kept `{{...}}` token reads as head text, a scheme or a host: a `/` after
 * `http://{{host}}` opens the path.
 */
function afterUrlToken(where: UrlComponent): UrlComponent {
	return where === "headSeparator" ? "head" : where;
}

/**
 * The component in force after `text`, read from `from`: in the head a `/`
 * opens the path unless it follows a `:` or a `/`, the first `?` before the
 * fragment opens the query, `#` opens the fragment. A whole `{{...}}` token
 * reads as head text.
 */
export function advanceUrlComponent(text: string, from: UrlComponent): UrlComponent {
	let where = from;
	for (let at = 0; at < text.length && where !== "fragment";) {
		const end = tokenEnd(text, at);
		if (end !== -1) {
			where = afterUrlToken(where);
			at = end;
			continue;
		}
		where = afterUrlChar(text[at++], where);
	}
	return where;
}

type ByteSet = (byte: number, where: UrlComponent) => boolean;

/** Written for a substituted value: the Postman set of the component it lands in. */
function inSubstitutedSet(byte: number, where: UrlComponent): boolean {
	if (inHead(where)) return false;
	if (isUnsendableByte(byte)) return true;
	switch (where) {
		case "path":
			return inPathEncodeSet(byte);
		case "query":
			return SUBSTITUTED_ENCODE_ASCII.has(byte);
		default:
			return FRAGMENT_ENCODE_ASCII.has(byte);
	}
}

/** Written for literal text: only what no request target may carry raw, outside the head. */
const inLiteralSet: ByteSet = (byte, where) => !inHead(where) && isUnsendableByte(byte);

/**
 * `text` with each byte `inSet` accepts at the component it is read in written
 * as `%XX`, every whole `{{...}}` token kept verbatim, and the component
 * advanced past it. The component moves *before* a byte is judged, so a `?`
 * or `#` is always structure, never encoded.
 */
function encodeByComponent(
	text: string,
	from: UrlComponent,
	inSet: ByteSet
): { written: string; where: UrlComponent } {
	let where = from;
	let out = "";
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end !== -1) {
			out += text.slice(at, end);
			where = afterUrlToken(where);
			at = end;
			continue;
		}
		// A whole code point, so a character outside the BMP encodes as its
		// UTF-8 bytes rather than as two lone surrogates.
		const char = String.fromCodePoint(text.codePointAt(at) ?? 0);
		at += char.length;
		where = afterUrlChar(char, where);
		// Every byte of a multi-byte character is above `~`, so a set takes all
		// of them or none, and a kept character is written whole.
		const bytes = encoder.encode(char);
		out += bytes.some((byte) => inSet(byte, where))
			? [...bytes]
					.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
					.join("")
			: char;
	}
	return { written: out, where };
}

/**
 * `value` written into a URL at `from`, and the component it leaves the URL
 * in: the engine's `encode_at_url_component`. Postman substitutes into the URL
 * string and parses it again, so a value is URL text: its `/` makes path
 * segments, its `?` opens the query, its `#` the fragment, its `&` and `=`
 * split pairs. Each component is encoded by its Postman set - the path by
 * `PATH_ENCODE_SET`, the query by `QUERY_ENCODE_SET`, the fragment by
 * `FRAGMENT_ENCODE_SET` - and the head as it stands, because a host is never
 * percent-encoded. `%` passes, so nothing is encoded twice.
 */
export function encodeAtUrlComponent(
	value: string,
	from: UrlComponent
): { written: string; where: UrlComponent } {
	return encodeByComponent(value, from, inSubstitutedSet);
}

/**
 * Literal URL text at `from` with only the bytes no request target may carry
 * raw encoded, outside the head: the engine's `encode_literal_at_url_component`.
 * Every other byte goes out as typed, as it did before issue #2465.
 */
export function encodeLiteralAtUrlComponent(
	text: string,
	from: UrlComponent
): { written: string; where: UrlComponent } {
	return encodeByComponent(text, from, inLiteralSet);
}

/**
 * `url` with each `{{...}}` token resolved through `resolve` and written as
 * URL text at the component the text before it has reached, and the literal
 * text around the tokens made sendable: the engine's `substitute_url_tokens`.
 * `resolve` gets the token alone, so a layered value is resolved whole and
 * encoded once. `encode: false` is `disableUrlEncoding`: nothing is encoded.
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
		const literal = encodeLiteralAtUrlComponent(url.slice(plain, at), where);
		const value = encodeAtUrlComponent(resolve(url.slice(at, end)), literal.where);
		where = value.where;
		out += literal.written + value.written;
		plain = at = end;
	}
	return out + encodeLiteralAtUrlComponent(url.slice(plain), where).written;
}
