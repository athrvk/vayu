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
 *
 * The same file holds the rest of the line Vayu sends (issue #2465):
 * `encodeUrlAsPostman` is the engine's `core::encode_url_as_postman`
 * (`engine/src/core/url_encoding.cpp`) and `resolveUrlTemplate` its
 * `substitute_url_tokens`, both pinned by the same fixture.
 */

import {
	inPathEncodeSet,
	encodePathVariableValue,
	mapOutsideTokens,
	maskTokens,
	tokenEnd,
} from "./path-variables";

/** Which side of `key=value` a component is: only a key encodes `=`. */
export type QueryPart = "key" | "value";

const encoder = new TextEncoder();

const asciiSet = (chars: string) => new Set([...chars].map((char) => char.charCodeAt(0)));

/**
 * What no request target may carry raw: the C0 controls, space, DEL and every
 * byte above `~`. Each Postman set contains it.
 */
const isUnsendableByte = (byte: number) => byte <= 0x20 || byte >= 0x7f;

/** `QUERY_ENCODE_SET`'s ASCII beyond the controls, plus `unparseSingle`'s `&`. */
const VALUE_ENCODE_ASCII = asciiSet(` "#'<>&`);
const KEY_ENCODE_ASCII = asciiSet(` "#'<>&=`);

/** `QUERY_ENCODE_SET`'s ASCII beyond the controls; its `#` is structure in a URL. */
const QUERY_ENCODE_ASCII = asciiSet(` "'<>`);

/** `FRAGMENT_ENCODE_SET`'s ASCII beyond the controls. */
const FRAGMENT_ENCODE_ASCII = asciiSet(` "<>\``);

/** `USERINFO_ENCODE_SET`: the path set's ASCII extended with `/ : ; = @ [ \ ] ^ |`. */
const USERINFO_ENCODE_ASCII = asciiSet(` "<>\`#?{}/:;=@[\\]^|`);

type ByteSet = (byte: number) => boolean;

const inAscii =
	(ascii: ReadonlySet<number>): ByteSet =>
	(byte) =>
		isUnsendableByte(byte) || ascii.has(byte);

function percentEncode(text: string, inSet: ByteSet): string {
	let out = "";
	for (const byte of encoder.encode(text)) {
		out += inSet(byte)
			? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
			: String.fromCharCode(byte);
	}
	return out;
}

/** `text` with each byte `inSet` accepts written as `%XX`, every whole `{{...}}` token kept. */
const encodeOutsideTokens = (text: string, inSet: ByteSet) =>
	mapOutsideTokens(text, (plain) => percentEncode(plain, inSet));

/** `text` as Postman writes it into a query as a key or a value. */
export function encodeQueryComponent(text: string, part: QueryPart): string {
	return encodeOutsideTokens(
		text,
		inAscii(part === "key" ? KEY_ENCODE_ASCII : VALUE_ENCODE_ASCII)
	);
}

/**
 * Which part of a URL a point in its text sits in (issues #1773, #2465), the
 * engine's `core::UrlComponent`. `head` is the scheme and the authority;
 * `headSeparator` is the head just after a `:` or `/`, where a `/` continues a
 * `://` rather than opening the path. A query key and value are one
 * component: substituted text encodes both alike.
 */
export type UrlComponent = "head" | "headSeparator" | "path" | "query" | "fragment";

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

/** The component reading `text` at `from` leaves the URL in: `advance_url_component`. */
export function advanceUrlComponent(text: string, from: UrlComponent): UrlComponent {
	let where = from;
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end === -1) {
			where = afterUrlChar(text[at++], where);
			continue;
		}
		where = afterUrlToken(where);
		at = end;
	}
	return where;
}

/** Written for a substituted value: the Postman set of the component it lands in. */
function inSubstitutedSet(byte: number, where: UrlComponent): boolean {
	if (inHead(where)) return false;
	if (isUnsendableByte(byte)) return true;
	switch (where) {
		case "path":
			return inPathEncodeSet(byte);
		case "query":
			return QUERY_ENCODE_ASCII.has(byte);
		default:
			return FRAGMENT_ENCODE_ASCII.has(byte);
	}
}

/**
 * `value` written into a URL at `from`, and the component it leaves the URL
 * in: the engine's `encode_at_url_component`. Postman substitutes into the URL
 * string and parses it again, so a value is URL text: its `/` makes path
 * segments, its `?` opens the query, its `#` the fragment, its `&` and `=`
 * split pairs. Each component is encoded by its Postman set - the path by
 * `PATH_ENCODE_SET`, the query by `QUERY_ENCODE_SET`, the fragment by
 * `FRAGMENT_ENCODE_SET` - and the head as it stands, which
 * `encodeUrlAsPostman` then lowercases and punycodes. `%` passes, so nothing
 * is encoded twice. The component moves *before* a byte is judged, so a `?`
 * or `#` is always structure, never encoded, and every whole `{{...}}` token
 * is kept verbatim.
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
			where = afterUrlToken(where);
			at = end;
			continue;
		}
		// A whole code point, so a character outside the BMP encodes as its
		// UTF-8 bytes rather than as two lone surrogates.
		const char = String.fromCodePoint(value.codePointAt(at) ?? 0);
		at += char.length;
		where = afterUrlChar(char, where);
		// Every byte of a multi-byte character is above `~`, so a set takes all
		// of them or none, and a kept character is written whole.
		const bytes = encoder.encode(char);
		out += bytes.some((byte) => inSubstitutedSet(byte, where))
			? percentEncode(char, () => true)
			: char;
	}
	return { written: out, where };
}

const lowerAscii = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const isAscii = (text: string) => ![...text].some((char) => char.charCodeAt(0) >= 0x80);

/**
 * `url.domainToASCII`, which `toNodeUrl` calls on the host: `host` parsed as a
 * special scheme's domain (IDNA), or `null` where that has no answer and the
 * host stays as typed. A host with no non-ASCII byte is its own answer.
 */
function asciiHost(host: string): string | null {
	if (isAscii(host)) return host;
	try {
		return new URL(`ws://${host}`).hostname;
	} catch {
		return null;
	}
}

/** `toNodeUrl`'s host: lowercased, then punycoded; `hostPort` may end in a `:port`. */
function encodeHost(hostPort: string): string {
	const lowered = mapOutsideTokens(hostPort, lowerAscii);
	if (lowered.startsWith("[")) return lowered;
	const colon = maskTokens(lowered).indexOf(":");
	const end = colon === -1 ? lowered.length : colon;
	const ascii = asciiHost(lowered.slice(0, end));
	return ascii === null ? lowered : ascii + lowered.slice(end);
}

function encodeUserInfo(userInfo: string): string {
	const inSet = inAscii(USERINFO_ENCODE_ASCII);
	const colon = maskTokens(userInfo).indexOf(":");
	if (colon === -1) return encodeOutsideTokens(userInfo, inSet);
	return `${encodeOutsideTokens(userInfo.slice(0, colon), inSet)}:${encodeOutsideTokens(userInfo.slice(colon + 1), inSet)}`;
}

/**
 * Where the authority starts in `head`: after the first `://` and any further
 * slashes (the parser drops those, keeping one for `file`), or at the start
 * when there is no `://`.
 */
function authorityStart(head: string, view: string): number {
	for (let colon = view.indexOf(":"); colon !== -1; colon = view.indexOf(":", colon + 1)) {
		if (!view.startsWith("//", colon + 1)) continue;
		let authority = colon + 3;
		while (head[authority] === "/") authority++;
		if (authority > colon + 3 && head.slice(0, colon).toLowerCase() === "file") authority--;
		return authority;
	}
	return 0;
}

/** The scheme, user info, host and path of `head` (no query, no fragment). */
function encodeHead(head: string): string {
	const view = maskTokens(head);
	const authority = authorityStart(head, view);
	const slash = view.indexOf("/", authority);
	const pathAt = slash === -1 ? head.length : slash;
	const atSign = view.slice(authority, pathAt).lastIndexOf("@");
	const hostAt = atSign === -1 ? authority : authority + atSign + 1;
	const userInfo =
		atSign === -1 ? "" : `${encodeUserInfo(head.slice(authority, authority + atSign))}@`;
	return (
		head.slice(0, authority) +
		userInfo +
		encodeHost(head.slice(hostAt, pathAt)) +
		encodePathVariableValue(head.slice(pathAt))
	);
}

/** Each `&`-separated pair split at its first `=` and written as a key and a value. */
function encodeQuery(query: string): string {
	const view = maskTokens(query);
	const pairs: string[] = [];
	for (let begin = 0; ;) {
		const amp = view.indexOf("&", begin);
		const end = amp === -1 ? query.length : amp;
		const equals = view.slice(begin, end).indexOf("=");
		const pair = query.slice(begin, end);
		pairs.push(
			equals === -1
				? encodeQueryComponent(pair, "key")
				: `${encodeQueryComponent(pair.slice(0, equals), "key")}=${encodeQueryComponent(pair.slice(equals + 1), "value")}`
		);
		if (amp === -1) return pairs.join("&");
		begin = amp + 1;
	}
}

/**
 * `url` as `postman-url-encoder` 3.0.8's `toNodeUrl (url, false)` writes it,
 * and so as Send puts it on the wire (issue #2465): leading whitespace dropped,
 * a backslash before the query a `/`, user info by `USERINFO_ENCODE_SET`, the
 * host lowercased and punycoded, the path, each query key and value and the
 * fragment by their sets. `%` is in no set, so an escape already in the text
 * passes and the result is idempotent; a whole `{{...}}` token is kept.
 */
export function encodeUrlAsPostman(url: string): string {
	const text = url.replace(/^[ \t\n\v\f\r]+/, "");
	const view = maskTokens(text);
	const hashAt = view.indexOf("#");
	const beforeFragment = hashAt === -1 ? text.length : hashAt;
	const queryAt = view.slice(0, beforeFragment).indexOf("?");
	const headEnd = queryAt === -1 ? beforeFragment : queryAt;

	let out = encodeHead(
		mapOutsideTokens(text.slice(0, headEnd), (plain) => plain.replace(/\\/g, "/"))
	);
	if (queryAt !== -1) out += `?${encodeQuery(text.slice(queryAt + 1, beforeFragment))}`;
	if (hashAt !== -1) {
		out += `#${encodeOutsideTokens(text.slice(hashAt + 1), inAscii(FRAGMENT_ENCODE_ASCII))}`;
	}
	return out;
}

/**
 * `url` with each `{{...}}` token resolved through `resolve` and written as
 * URL text at the component the text before it has reached, and then the whole
 * URL written as Send puts it on the wire (`encodeUrlAsPostman`): the engine's
 * `substitute_url_tokens`. `resolve` gets the token alone, so a layered value
 * is resolved whole and encoded once. `encode: false` is `disableUrlEncoding`:
 * nothing is encoded, the host included.
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
		const value = encodeAtUrlComponent(
			resolve(url.slice(at, end)),
			advanceUrlComponent(literal, where)
		);
		where = value.where;
		out += literal + value.written;
		plain = at = end;
	}
	return encodeUrlAsPostman(out + url.slice(plain));
}
