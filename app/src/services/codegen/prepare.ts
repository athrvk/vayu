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
import { substitutePathVariables } from "@/modules/request-builder/utils/path-variables";
import {
	encodeAtUrlComponent,
	encodeQueryComponent,
} from "@/modules/request-builder/utils/query-encoding";
import { isSensitiveHeaderName } from "@/lib/sensitive-headers";
import { AUTH_MODE_LABELS, isUneditableAuthMode } from "@/constants/auth-modes";

/** A multipart part that uploads a file - its path, and what it declares. */
export interface PreparedFilePart {
	key: string;
	path: string;
	fileName?: string;
	contentType?: string;
}

export type PreparedBody =
	| { kind: "raw"; content: string }
	| { kind: "binary"; path: string }
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

/**
 * What to call a mode we cannot put in a snippet, for the note. OAuth 2.0 is
 * sent by the engine at send time; the stored-but-unexecuted modes are not sent
 * by Vayu at all, so the snippet matches what Vayu does (#2474).
 */
function unreproducibleAuthName(mode: string): string {
	if (mode === "oauth2")
		return "OAuth 2.0 - Vayu's engine fetches and attaches the token at send time";
	if (isUneditableAuthMode(mode))
		return `${AUTH_MODE_LABELS[mode]} - Vayu does not send this auth type`;
	return `${mode} auth`;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * A secret as it can appear in a URL: as written, as substituted into URL text
 * (`encodeAtUrlComponent`, the rule compose and the "Sends" line apply to a
 * `{{token}}` in the host, the path, the query or the fragment, each by its own
 * set, which leaves `&` and `=` raw), as a query row's value
 * (`encodeQueryComponent`) and as `encodeURIComponent` writes it. The raw
 * value alone would miss `a b&c` sitting there as `a%20b&c`, and a path
 * writes `{` and a backtick where a query leaves them.
 */
function secretForms(secret: string): string[] {
	return [
		secret,
		encodeAtUrlComponent(secret, "head").written,
		encodeAtUrlComponent(secret, "path").written,
		encodeAtUrlComponent(secret, "query").written,
		encodeAtUrlComponent(secret, "fragment").written,
		encodeQueryComponent(secret, "value"),
		encodeURIComponent(secret),
	];
}

/**
 * Replace every secret value wherever it appears, and every header whose name
 * says it holds a credential.
 *
 * Longest first, over the encoded forms too: two secrets where one is a prefix
 * of the other would otherwise leave the tail of the longer one in the output.
 * Empty and whitespace-only entries are dropped before expanding - a variable
 * set to "" would otherwise match at every position and shred the string.
 *
 * A header row is replaced whole, whatever it holds: a typed `Authorization`
 * is not a variable, so its name is the only signal there is
 * (`isSensitiveHeaderName`).
 *
 * `placeholder` is what each hit becomes: `<secret>` for code, which must stay
 * readable as text, and a surface that shows the value in a UI picks its own.
 */
export function createSecretMasker(
	secrets: string[] | undefined,
	active: boolean | undefined,
	apiKeyHeaderName?: string,
	placeholder: string = SECRET_PLACEHOLDER
) {
	const values = active
		? [
				...new Set((secrets ?? []).filter((s) => s.trim().length > 0).flatMap(secretForms)),
			].sort((a, b) => b.length - a.length)
		: [];
	let used = false;
	const apply = (text: string): string => {
		let out = text;
		for (const secret of values) {
			if (!out.includes(secret)) continue;
			used = true;
			out = out.split(secret).join(placeholder);
		}
		return out;
	};
	const applyHeader = (name: string, value: string): string => {
		if (!active || value.trim() === "" || !isSensitiveHeaderName(name, apiKeyHeaderName)) {
			return apply(value);
		}
		used = true;
		return placeholder;
	};
	return { apply, applyHeader, wasUsed: () => used };
}

/**
 * Append a query parameter to a URL that may or may not already have some -
 * encoded with Postman's query rule (issue #1771) unless the request sends its
 * URL as written (issue #1765), as the engine's `append_query_param` does.
 */
function appendQueryParam(url: string, key: string, value: string, encode: boolean): string {
	const encoded = encode
		? `${encodeQueryComponent(key, "key")}=${encodeQueryComponent(value, "value")}`
		: `${key}=${value}`;
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
 * envelopes, XML's document, and `text` as `text/plain` - carries it. A text
 * body that is really a CSV or a JWT declares its own header, which wins.
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
export const IMPLIED_CONTENT_TYPE: Readonly<Record<string, string>> = {
	json: "application/json",
	graphql: "application/json",
	jsonrpc: "application/json",
	xml: "application/xml",
	text: "text/plain",
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
	const shape = typeof body === "object" && body !== null ? (body as SnippetBody) : undefined;
	const implied =
		shape?.mode === "binary"
			? binaryContentType(shape)
			: IMPLIED_CONTENT_TYPE[shape?.mode ?? ""];
	if (!implied) return headers;
	if (headers.some(([key]) => key.toLowerCase() === "content-type")) return headers;
	return [...headers, ["Content-Type", implied]];
}

/**
 * The Content-Type a `binary` body is snippeted under when no header declares
 * one: the file's own declared type, else `application/octet-stream`. Always
 * a value, never absent, because every client here has a worse default for a
 * file body than "bytes" - curl's `--data-binary` sends
 * `application/x-www-form-urlencoded`, and a server that believes it parses
 * the file as form fields. The engine's extension table (a `.png` goes out as
 * `image/png`) is not mirrored here; a snippet that wants that type names it
 * on the file or as a header, and octet-stream is the honest fallback.
 */
function binaryContentType(body: SnippetBody): string {
	const declared = body.file?.contentType?.trim();
	return declared ? declared : "application/octet-stream";
}

function normalizeBody(body: unknown): PreparedBody | undefined {
	if (body === undefined || body === null) return undefined;
	// A body sent as a bare string (nothing in the app does today, but the
	// engine's payload type is `unknown`) is content, not a mode object.
	if (typeof body === "string") return body ? { kind: "raw", content: body } : undefined;
	if (typeof body !== "object") return undefined;

	const shape = body as SnippetBody;
	if (shape.mode === "none") return undefined;

	// A file body with no file chosen sends nothing (the engine refuses it), so
	// there is no command to write for it.
	if (shape.mode === "binary") {
		const path = shape.file?.src ?? "";
		return path ? { kind: "binary", path } : undefined;
	}

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
 * file part's or a binary body's path included, since a `{{token}}`-built path would otherwise
 * print the secret the rest of the snippet hides.
 */
function maskedBody(body: PreparedBody, mask: (text: string) => string): PreparedBody {
	if (body.kind === "raw") return { kind: "raw", content: mask(body.content) };
	if (body.kind === "binary") return { kind: "binary", path: mask(body.path) };
	const fields = body.fields.map(([k, v]): [string, string] => [k, mask(v)]);
	if (body.kind === "urlencoded") return { kind: "urlencoded", fields };
	return {
		kind: "form-data",
		fields,
		files: body.files.map((file) => ({ ...file, path: mask(file.path) })),
	};
}

/**
 * Whether the rows already carry a header called `name`, compared
 * case-insensitively as the engine's header map does.
 */
function carriesHeader(headers: Array<[string, string]>, name: string): boolean {
	const folded = name.toLowerCase();
	return headers.some(([key]) => key.toLowerCase() === folded);
}

/**
 * Flatten a request into what a static client has to send, with auth applied
 * and secrets already hidden.
 *
 * A header the request already carries wins over the one its auth would write,
 * as in the engine's `apply_auth` (`engine/src/http/auth_resolver.cpp`), pinned
 * to it by `engine/tests/fixtures/auth-header-precedence.json` (issue #2475):
 * appending both made a snippet send two `Authorization` lines where Vayu sends
 * one. A query-located API key is a URL parameter, not a header, and is never
 * skipped.
 */
export function prepareRequest(
	request: SnippetRequest,
	options: CodegenOptions = {}
): PreparedRequest {
	const notes: string[] = [];

	// Path variables first, as the engine composes them (issue #1764), so a
	// query-located API key appended below lands after the substituted path.
	// Raw under `disableUrlEncoding` (issue #1765), as the engine substitutes.
	const encode = request.disableUrlEncoding !== true;
	let url = substitutePathVariables(request.url ?? "", request.params ?? [], undefined, {
		encode,
	});
	const headers: Array<[string, string]> = Object.entries(request.headers ?? {});
	let basicAuth: { username: string; password: string } | null = null;

	const auth = request.auth;
	const mode = auth ? asString(auth.mode) : "";
	const masker = createSecretMasker(options.secrets, options.mask, apiKeyHeaderName(auth));
	switch (mode) {
		case "":
		case "none":
		case "noauth":
			break;
		case "bearer":
			if (!carriesHeader(headers, "Authorization")) {
				headers.push(["Authorization", `Bearer ${asString(auth!.token)}`]);
			}
			break;
		case "basic":
			// Left null, not a header: `basicAuth` is rendered as its own
			// `Authorization` by every target (`-u`, `-a`, `auth=`, `btoa`), so a
			// typed one has to keep the structured path unused.
			if (!carriesHeader(headers, "Authorization")) {
				basicAuth = {
					username: asString(auth!.username),
					password: asString(auth!.password),
				};
			}
			break;
		case "apikey": {
			const key = asString(auth!.key);
			const value = asString(auth!.value);
			if (key) {
				if (asString(auth!.in) === "query") url = appendQueryParam(url, key, value, encode);
				else if (!carriesHeader(headers, key)) headers.push([key, value]);
			}
			break;
		}
		default:
			notes.push(
				`This request uses ${unreproducibleAuthName(mode)}, so the snippet carries no credentials.`
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
		headers: withContentType.map(([k, v]): [string, string] => [k, masker.applyHeader(k, v)]),
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

/** A code unit above U+00FF: no Latin-1 byte exists for it. */
const ABOVE_LATIN1 = /[\u0100-\uffff]/;
/** U+0080..U+00FF: one Latin-1 byte here, two UTF-8 bytes in Vayu. */
const LATIN1_HIGH = /[\u0080-\u00ff]/;

/**
 * Notes for header values a Latin-1 client cannot send the way Vayu does.
 *
 * Vayu writes a header value as UTF-8. `fetch` and `requests` take a header
 * as Latin-1: a character above U+00FF makes them throw before anything is
 * sent, and one in U+0080..U+00FF goes out as a single byte where Vayu sends
 * two, so the server reads a different value. Nothing is transcoded - the
 * snippet stays the request as written and says where the client differs.
 * The basic-auth pair counts as the `Authorization` value both targets build
 * from it (`btoa`, the `auth=` tuple), and a masked value is the placeholder
 * the snippet actually carries.
 */
export function headerEncodingNotes(
	prepared: PreparedRequest,
	client: "fetch" | "requests"
): string[] {
	const values = [...prepared.headers];
	if (prepared.basicAuth) {
		values.push([
			"Authorization",
			`${prepared.basicAuth.username}:${prepared.basicAuth.password}`,
		]);
	}
	const notes: string[] = [];
	for (const [name, value] of values) {
		if (ABOVE_LATIN1.test(value)) {
			notes.push(
				`The ${name} header has characters above U+00FF, which are not representable in a ${client} header, so ${client} rejects it.`
			);
		} else if (LATIN1_HIGH.test(value)) {
			notes.push(
				`The ${name} header has characters in U+0080 to U+00FF, which ${client} sends as Latin-1 where Vayu sends UTF-8, so the server may read a different value.`
			);
		}
	}
	return notes;
}

/**
 * The header an API-key auth writes its key into, or none when it writes a
 * query parameter instead (that value is masked by value, like any secret).
 */
function apiKeyHeaderName(auth: Record<string, unknown> | undefined): string | undefined {
	if (!auth || asString(auth.mode) !== "apikey" || asString(auth.in) === "query")
		return undefined;
	return asString(auth.key) || undefined;
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

/**
 * Every value a snippet must hide: the secret variables in `variables` plus the
 * request's own auth credentials. The one place that list is built, so a second
 * surface showing the resolved request masks exactly what the snippet does;
 * hand it to `createSecretMasker`, which adds the encoded forms.
 */
export function collectSecrets(
	variables: Record<string, { value: string; secret?: boolean }>,
	auth: Record<string, unknown> | undefined
): string[] {
	return [
		...Object.values(variables)
			.filter((v) => v.secret)
			.map((v) => v.value),
		...authSecrets(auth),
	];
}
