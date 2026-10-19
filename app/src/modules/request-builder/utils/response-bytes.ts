/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A response body as the engine sent it, turned into what the pane shows
 * (issue #2458).
 *
 * `POST /execute` answers a body that is not UTF-8 text as base64
 * (`bodyEncoding: "base64"`), and the stored trace marks the same body the same
 * way. The engine decodes no declared charset, so this is where one is
 * honoured. Both response funnels call `decodeResponseBody`, so a restored
 * response shows the text and holds the bytes the live one did.
 */

import type { ResponseState } from "../types";

/** How `bodyRaw` is spelled on the wire. Absent means `"utf8"`. */
export type BodyEncoding = "utf8" | "base64";

/** Why the text on screen is not a faithful reading of the bytes. */
export interface DecodeNotice {
	/** The charset the text was decoded with, as `TextDecoder` names it. */
	charset: string;
	/** The declared label `TextDecoder` does not know, which is why `charset` is UTF-8. */
	unknownLabel?: string;
	/** Some bytes are not valid in `charset` and are shown as U+FFFD. */
	replaced: boolean;
}

/** A base64 body's exact bytes, and what its text beside it is. */
export interface ResponseBytes {
	data: Uint8Array<ArrayBuffer>;
	/**
	 * The content type is text, so the body's text is a decoding of `data`.
	 * False means there is no text view at all: an image, a PDF, an archive.
	 */
	isText: boolean;
	notice?: DecodeNotice;
}

export interface DecodedBody {
	/** What the pane shows. Empty for a body whose type is not text. */
	text: string;
	/** Present exactly when the body arrived as base64. */
	bytes?: ResponseBytes;
}

/** The Content-Type header's value, whatever case its name arrived in. */
export function contentTypeOf(headers: Record<string, string> | undefined): string {
	if (!headers) return "";
	const key = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
	return key ? headers[key] : "";
}

/** A Content-Type split into the parts a type decision reads, lowercased. */
export interface MediaType {
	/** `application` in `application/vnd.api+json`. */
	type: string;
	/** `vnd.api+json`, the whole subtype. */
	subtype: string;
	/** `vnd.api`, the subtype before any `+suffix`, with a leading `x-` dropped. */
	name: string;
	/** `json`, the structured-syntax suffix (RFC 6839), or `""` when there is none. */
	suffix: string;
}

/**
 * The parts of a Content-Type, so a decision compares whole tokens. A
 * substring test answers for the wrong type: `xml` occurs inside
 * `vnd.openxmlformats-officedocument.spreadsheetml.sheet`, which is a zip.
 */
export function mediaTypeOf(contentType: string): MediaType {
	const essence = contentType.split(";")[0].trim().toLowerCase();
	const slash = essence.indexOf("/");
	const type = slash < 0 ? essence : essence.slice(0, slash);
	const subtype = slash < 0 ? "" : essence.slice(slash + 1);
	const plus = subtype.lastIndexOf("+");
	const base = plus < 0 ? subtype : subtype.slice(0, plus);
	return {
		type,
		subtype,
		name: base.replace(/^x-/, ""),
		suffix: plus < 0 ? "" : subtype.slice(plus + 1),
	};
}

/** Subtype names (after `x-`) that are text under any top-level type. */
const TEXT_SUBTYPE_NAMES: ReadonlySet<string> = new Set([
	"json",
	"ndjson",
	"xml",
	"javascript",
	"ecmascript",
	"www-form-urlencoded",
	"yaml",
	"graphql",
]);

/** Structured-syntax suffixes that are text: `atom+xml`, `ld+json`, `openapi+yaml`. */
const TEXT_SUFFIXES: ReadonlySet<string> = new Set(["json", "xml", "yaml"]);

/**
 * Whether a body of this type is text to read rather than bytes to keep. A
 * declared charset counts on its own: the parameter means nothing on anything
 * else. An absent type does not: the engine already said the bytes are not
 * UTF-8, and guessing a charset for an unlabelled body would show noise.
 */
function isTextContentType(contentType: string): boolean {
	const { type, name, suffix } = mediaTypeOf(contentType);
	return (
		type === "text" ||
		TEXT_SUBTYPE_NAMES.has(name) ||
		TEXT_SUFFIXES.has(suffix) ||
		charsetLabel(contentType) !== undefined
	);
}

function charsetLabel(contentType: string): string | undefined {
	const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
	return match?.[1].toLowerCase();
}

/** A byte-order mark outranks the declared label, as the WHATWG decode algorithm has it. */
function bomCharset(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	return undefined;
}

function decodeText(
	bytes: Uint8Array,
	contentType: string
): { text: string; notice?: DecodeNotice } {
	const label = bomCharset(bytes) ?? charsetLabel(contentType) ?? "utf-8";
	let charset: string;
	let unknownLabel: string | undefined;
	try {
		charset = new TextDecoder(label).encoding;
	} catch {
		charset = "utf-8";
		unknownLabel = label;
	}

	try {
		const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
		return unknownLabel
			? { text, notice: { charset, unknownLabel, replaced: false } }
			: { text };
	} catch {
		const text = new TextDecoder(charset).decode(bytes);
		return { text, notice: { charset, replaced: true, ...(unknownLabel && { unknownLabel }) } };
	}
}

function bytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
	let binary: string;
	try {
		binary = atob(base64);
	} catch (cause) {
		throw new Error("The engine marked this response body base64, and it does not decode.", {
			cause,
		});
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * The body the pane shows, from the engine's spelling of it.
 *
 * A `"utf8"` (or absent) body is its own text. A `"base64"` one is decoded to
 * bytes, and a text type is then read through `TextDecoder` with the BOM's
 * charset, else the declared one, else UTF-8; a label the platform does not
 * know falls back to UTF-8 and says so in `notice`.
 */
export function decodeResponseBody({
	bodyRaw,
	bodyEncoding,
	headers,
}: {
	bodyRaw: string;
	bodyEncoding?: string;
	headers?: Record<string, string>;
}): DecodedBody {
	if (bodyEncoding === undefined || bodyEncoding === "utf8") return { text: bodyRaw };
	if (bodyEncoding !== "base64") {
		throw new Error(`The engine sent a response body in an unknown encoding: ${bodyEncoding}.`);
	}

	const data = bytesFromBase64(bodyRaw);
	const contentType = contentTypeOf(headers);
	if (!isTextContentType(contentType)) return { text: "", bytes: { data, isText: false } };

	const { text, notice } = decodeText(data, contentType);
	return { text, bytes: { data, isText: true, ...(notice && { notice }) } };
}

/**
 * `ResponseState.bodyType`, the same answer from either funnel: `binary` for a
 * base64 body with no text view, otherwise read off the Content-Type.
 */
export function responseBodyType(
	headers: Record<string, string> | undefined,
	bytes: ResponseBytes | undefined
): ResponseState["bodyType"] {
	if (bytes && !bytes.isText) return "binary";
	const { name, suffix } = mediaTypeOf(contentTypeOf(headers));
	if (name === "json" || suffix === "json") return "json";
	if (name === "html" || name === "xhtml") return "html";
	if (name === "xml" || suffix === "xml") return "xml";
	return "text";
}

/**
 * How much body this response holds, for a notice that says "the first N".
 * The bytes when there are some: a base64 body's text is a decoding, or empty.
 */
export function heldBodySize(response: Pick<ResponseState, "body" | "rawBytes">): number {
	return response.rawBytes?.data.length ?? response.body.length;
}

const EXTENSION_BY_SUBTYPE: Record<string, string> = {
	"octet-stream": "bin",
	plain: "txt",
	jpeg: "jpg",
	"svg+xml": "svg",
	javascript: "js",
	markdown: "md",
	gzip: "gz",
};

/**
 * A file extension for a downloaded body of this type: the subtype when it is
 * a plausible extension (`png`, `pdf`, `zip`), the few that are not mapped,
 * and `bin` for anything else.
 */
export function extensionForContentType(contentType: string): string {
	const { subtype } = mediaTypeOf(contentType);
	const mapped = EXTENSION_BY_SUBTYPE[subtype] ?? subtype.replace(/^x-/, "");
	return /^[a-z0-9]{1,8}$/.test(mapped) ? mapped : "bin";
}
