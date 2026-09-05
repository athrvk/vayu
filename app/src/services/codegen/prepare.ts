/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Everything both targets have to agree on before either starts quoting.
 *
 * Auth is the reason this file exists. The engine keeps `auth` as its own field
 * and applies it at send time, so a snippet built from the composed payload's
 * headers alone would be a request that authenticates in Vayu and 401s in a
 * terminal. Flattening it here - once - means curl and fetch cannot disagree
 * about what a bearer token becomes, and the modes neither of them can
 * reproduce produce the same note in both.
 *
 * Masking also happens here rather than over the finished string. A secret is
 * masked *before* quoting, so a value containing a quote character is still
 * found: after quoting it no longer matches itself.
 */

import {
	SECRET_PLACEHOLDER,
	type CodegenOptions,
	type SnippetBody,
	type SnippetRequest,
} from "./types";

/** A multipart part that uploads a file - its path, and what it declares. */
export interface PreparedFilePart {
	key: string;
	path: string;
	fileName?: string;
	contentType?: string;
}

export type PreparedBody =
	| { kind: "raw"; content: string }
	| { kind: "form-data"; fields: Array<[string, string]>; files: PreparedFilePart[] }
	| { kind: "urlencoded"; fields: Array<[string, string]> };

export interface PreparedRequest {
	method: string;
	url: string;
	headers: Array<[string, string]>;
	/**
	 * Basic credentials stay structured instead of being pre-encoded: curl says
	 * this with `-u` and never sees the base64, while fetch has to build the
	 * header itself. Encoding here would force curl to render a blob no reader
	 * can check.
	 */
	basicAuth: { username: string; password: string } | null;
	body: PreparedBody | undefined;
	/** Whether the response is a stream - see `SnippetRequest.stream`. */
	stream: boolean;
	/** Whether TLS verification is on - see `SnippetRequest.verifySSL`. */
	verifySSL: boolean;
	/** Whether redirects are followed - see `SnippetRequest.followRedirects`. */
	followRedirects: boolean;
	notes: string[];
	masked: boolean;
}

/** What a mode's credentials are called, for the note when we cannot send them. */
const UNREPRODUCIBLE_AUTH: Record<string, string> = {
	oauth2: "OAuth 2.0 - the engine fetches and attaches the token at send time",
	digest: "Digest - the challenge/response happens on the wire",
	aws: "AWS Signature - the signature covers this exact request and is computed at send time",
	ntlm: "NTLM - the handshake happens on the wire",
};

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Replace every secret value wherever it appears.
 *
 * Longest first: two secrets where one is a prefix of the other would otherwise
 * leave the tail of the longer one in the output. Empty and whitespace-only
 * entries are dropped - a variable set to "" would otherwise match at every
 * position and shred the string.
 */
function maskerFor(secrets: string[] | undefined, mask: boolean | undefined) {
	const values = mask
		? [...new Set((secrets ?? []).filter((s) => s.trim().length > 0))].sort(
				(a, b) => b.length - a.length
			)
		: [];
	let used = false;
	const apply = (text: string): string => {
		let out = text;
		for (const secret of values) {
			if (!out.includes(secret)) continue;
			used = true;
			out = out.split(secret).join(SECRET_PLACEHOLDER);
		}
		return out;
	};
	return { apply, wasUsed: () => used };
}

/** Append a query parameter to a URL that may or may not already have some. */
function appendQueryParam(url: string, key: string, value: string): string {
	const encoded = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
	// Split the fragment off first: a parameter appended after `#` lands in the
	// fragment and is never sent.
	const hash = url.indexOf("#");
	const base = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? "" : url.slice(hash);
	return `${base}${base.includes("?") ? "&" : "?"}${encoded}${fragment}`;
}

/**
 * The Content-Type a body mode is sent under when the request declares none.
 *
 * The engine's `implied_content_type` (`engine/src/http/form_body.cpp`) is what
 * reaches the wire, and this is the same table for the snippet: a mode whose
 * meaning includes its media type - JSON's, GraphQL's and JSON-RPC's JSON
 * envelopes, XML's document - carries it, and `text` does not, because a
 * `text/plain`, a CSV, a JWT and a raw signature are all that one mode and the
 * header is the author's to write.
 *
 * Without this, every snippet fell through as raw content with **no** header,
 * so a copied curl of a GraphQL request went out as libcurl's default
 * `application/x-www-form-urlencoded` and most servers answered 400 - a snippet
 * that does not do what the app just did. `json` fell through the same way
 * (issue #1445): the engine implies `application/json` for it exactly like
 * GraphQL and JSON-RPC, so a snippet that carried no header for a json-mode
 * body was already wrong the day it was generated, and pasting it back through
 * `parseCurl` landed it as `text` rather than `json`. The form modes are absent
 * on purpose: their generators express the body as `-F` / `--data-urlencode`
 * and the client writes the header itself, boundary included.
 */
const IMPLIED_CONTENT_TYPE: Record<string, string> = {
	json: "application/json",
	graphql: "application/json",
	jsonrpc: "application/json",
	xml: "application/xml",
};

/**
 * The header rows plus the one this body implies, if it is not already declared.
 *
 * A declared Content-Type wins, case-insensitively and whatever its value - the
 * same rule the engine applies (`body_content_type_header`) and the request
 * builder applies (`body/content-type.ts`): someone who typed
 * `application/soap+xml` means it.
 */
function withImpliedContentType(
	headers: Array<[string, string]>,
	body: unknown
): Array<[string, string]> {
	const mode = typeof body === "object" && body !== null ? (body as SnippetBody).mode : "";
	const implied = IMPLIED_CONTENT_TYPE[mode ?? ""];
	if (!implied) return headers;
	if (headers.some(([key]) => key.toLowerCase() === "content-type")) return headers;
	return [...headers, ["Content-Type", implied]];
}

function normalizeBody(body: unknown): PreparedBody | undefined {
	if (body === undefined || body === null) return undefined;
	// A body sent as a bare string (nothing in the app does today, but the
	// engine's payload type is `unknown`) is content, not a mode object.
	if (typeof body === "string") return body ? { kind: "raw", content: body } : undefined;
	if (typeof body !== "object") return undefined;

	const shape = body as SnippetBody;
	if (shape.mode === "none") return undefined;

	if (shape.mode === "form-data" || shape.mode === "x-www-form-urlencoded") {
		const enabled = (shape.fields ?? []).filter((f) => f.enabled !== false);
		// urlencoded has no file form on the wire, so a stray file row there is
		// not a part any snippet could express - the engine refuses it too.
		const isMultipart = shape.mode === "form-data";
		const files: PreparedFilePart[] = isMultipart
			? enabled
					.filter((f) => f.type === "file")
					.map((f) => ({
						key: f.key,
						path: f.src ?? "",
						fileName: f.fileName,
						contentType: f.contentType,
					}))
			: [];
		const fields = enabled
			.filter((f) => !(isMultipart && f.type === "file"))
			.map((f): [string, string] => [f.key, f.value]);
		if (fields.length === 0 && files.length === 0) return undefined;
		if (!isMultipart) return { kind: "urlencoded", fields };
		return { kind: "form-data", fields, files };
	}

	return shape.content ? { kind: "raw", content: shape.content } : undefined;
}

/**
 * The body with every string a secret could sit in run through the masker - a
 * file part's path included, since a `{{token}}`-built path would otherwise
 * print the secret the rest of the snippet hides.
 */
function maskedBody(body: PreparedBody, mask: (text: string) => string): PreparedBody {
	if (body.kind === "raw") return { kind: "raw", content: mask(body.content) };
	const fields = body.fields.map(([k, v]): [string, string] => [k, mask(v)]);
	if (body.kind === "urlencoded") return { kind: "urlencoded", fields };
	return {
		kind: "form-data",
		fields,
		files: body.files.map((file) => ({ ...file, path: mask(file.path) })),
	};
}

/**
 * Flatten a request into what a static client has to send, with auth applied
 * and secrets already hidden.
 */
export function prepareRequest(
	request: SnippetRequest,
	options: CodegenOptions = {}
): PreparedRequest {
	const masker = maskerFor(options.secrets, options.mask);
	const notes: string[] = [];

	let url = request.url ?? "";
	const headers: Array<[string, string]> = Object.entries(request.headers ?? {});
	let basicAuth: { username: string; password: string } | null = null;

	const auth = request.auth;
	const mode = auth ? asString(auth.mode) : "";
	switch (mode) {
		case "":
		case "none":
		case "noauth":
			break;
		case "bearer":
			headers.push(["Authorization", `Bearer ${asString(auth!.token)}`]);
			break;
		case "basic":
			basicAuth = {
				username: asString(auth!.username),
				password: asString(auth!.password),
			};
			break;
		case "apikey": {
			const key = asString(auth!.key);
			const value = asString(auth!.value);
			if (key) {
				if (asString(auth!.in) === "query") url = appendQueryParam(url, key, value);
				else headers.push([key, value]);
			}
			break;
		}
		default:
			notes.push(
				`This request uses ${UNREPRODUCIBLE_AUTH[mode] ?? `${mode} auth`}, so the snippet carries no credentials.`
			);
	}

	const body = normalizeBody(request.body);

	// After auth, so a header the request carries under any name still counts as
	// declared; and only when there is a body, because a mode with nothing in it
	// sends none - the engine's `has_wire_body` gate, which `normalizeBody`
	// already applied by returning undefined.
	const withContentType = body ? withImpliedContentType(headers, request.body) : headers;

	// Mask last, over everything at once, so a credential and a secret variable
	// that happen to hold the same value are hidden by the same pass.
	const maskedBasic = basicAuth
		? { username: masker.apply(basicAuth.username), password: masker.apply(basicAuth.password) }
		: null;

	return {
		method: (request.method || "GET").toUpperCase(),
		url: masker.apply(url),
		headers: withContentType.map(([k, v]): [string, string] => [k, masker.apply(v)]),
		basicAuth: maskedBasic,
		body: body ? maskedBody(body, masker.apply) : undefined,
		stream: request.stream === true,
		// Absent means verifying: the engine's default, and the safe reading of
		// a caller that never set it.
		verifySSL: request.verifySSL !== false,
		// Absent means following: the engine's own default (issue #1445), unlike
		// curl's, which is why the flag is worth emitting on the common case
		// rather than only when it departs from one.
		followRedirects: request.followRedirects !== false,
		notes,
		masked: masker.wasUsed(),
	};
}

/**
 * The credential values in a request, so the caller can hand them back as
 * secrets to mask. Auth credentials are secret whether or not they came from a
 * variable marked secret - a bearer token typed literally into the auth tab is
 * exactly as sensitive as one that came from a `{{token}}`.
 */
export function authSecrets(auth: Record<string, unknown> | undefined): string[] {
	if (!auth) return [];
	switch (asString(auth.mode)) {
		case "bearer":
			return [asString(auth.token)];
		case "basic":
			return [asString(auth.password)];
		case "apikey":
			return [asString(auth.value)];
		default:
			return [];
	}
}
