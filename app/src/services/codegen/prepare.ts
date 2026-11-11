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
import {
	mapOutsideTokens,
	maskTokens,
	substitutePathVariables,
} from "@/modules/request-builder/utils/path-variables";
import {
	appendQueryParam,
	encodeAtUrlComponent,
	encodeHost,
	encodeQueryComponent,
	resolveUrlTemplate,
	splitUrlUserInfo,
	trimCredential,
} from "@/modules/request-builder/utils/query-encoding";
import { headerLinesOf } from "@/lib/header-lines";
import { isSensitiveHeaderName } from "@/lib/sensitive-headers";
import { AUTH_MODE_LABELS, isUneditableAuthMode } from "@/constants/auth-modes";
import { pluralize } from "@/modules/dashboard/utils/format";
import { DEFAULT_HTTP_VERSION, isHttpVersion, type HttpVersion } from "@/constants/request";
import { curlEscape, graphqlGetQuery, urlWithQuery, wireBodyContent } from "./wire-body";

/** A multipart part that uploads a file - its path, and what it declares. */
export interface PreparedFilePart {
	kind: "file";
	key: string;
	path: string;
	fileName?: string;
	contentType?: string;
}

/**
 * A multipart text part: its key and value, and the Content-Type it declares
 * for itself when the request sets one (#2539). A snippet that cannot express
 * the type still writes the key and value and says so in a note.
 */
export interface PreparedTextPart {
	kind: "text";
	key: string;
	value: string;
	contentType?: string;
}

/** A multipart part, text or file. */
export type PreparedPart = PreparedTextPart | PreparedFilePart;

export type PreparedBody =
	| { kind: "raw"; content: string }
	| { kind: "binary"; path: string }
	// `parts` keeps the rows' order: the engine adds the parts to the multipart
	// tree in row order, so a generator that groups text before files sends a
	// different body (#3198).
	| { kind: "form-data"; parts: PreparedPart[] }
	| { kind: "urlencoded"; fields: Array<[string, string]> };

/**
 * The note for a client with no spelling for a text part's Content-Type: the
 * part is written untyped, and this says which ones, rather than leaving a
 * snippet that reads like the request and sends something else. Undefined when
 * no part declares one.
 */
export function untypedTextPartNote(
	body: PreparedBody | undefined,
	client: string
): string | undefined {
	if (body?.kind !== "form-data") return undefined;
	const keys = body.parts.flatMap((part) =>
		part.kind === "text" && part.contentType ? [part.key] : []
	);
	if (keys.length === 0) return undefined;
	return `${client} cannot set a text part's Content-Type: ${keys.join(", ")} ${pluralize(keys.length, "is", "are")} sent without the type the request declares.`;
}

export interface PreparedRequest {
	method: string;
	url: string;
	headers: Array<[string, string]>;
	/**
	 * Basic credentials stay structured instead of being pre-encoded: curl says
	 * this with `-u` and never sees the base64, while fetch has to build the
	 * header itself. Encoding here would force curl to render a blob no reader
	 * can check. The URL's own `user:pass@` lands here too, so no target's URL
	 * carries it.
	 */
	basicAuth: { username: string; password: string } | null;
	body: PreparedBody | undefined;
	/** Whether the response is a stream - see `SnippetRequest.stream`. */
	stream: boolean;
	/** Whether TLS verification is on - see `SnippetRequest.verifySSL`. */
	verifySSL: boolean;
	/** Whether redirects are followed - see `SnippetRequest.followRedirects`. */
	followRedirects: boolean;
	/**
	 * The redirect cap to state, or null when there is none to state: the request
	 * does not follow, or names no cap. Null is "say nothing", never a default.
	 */
	maxRedirects: number | null;
	/** The request's own deadline in milliseconds, or null when it states none. */
	timeoutMs: number | null;
	/** The protocol asked for. `auto` is what every client does unasked. */
	httpVersion: HttpVersion;
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
		return "OAuth 2.0 - Vayu's engine fetches and attaches the token at send time (unless the request has its own Authorization header)";
	if (isUneditableAuthMode(mode))
		return `${AUTH_MODE_LABELS[mode]} - Vayu does not send this auth type`;
	return `${mode} auth`;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

const PERCENT_ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * One half of a URL's user info as libcurl decodes it before building the
 * Basic header: a valid `%XX` run is read as UTF-8 bytes, a malformed escape
 * (`%zz`) stays literal, and a component whose escapes are not UTF-8 is left
 * exactly as written. A `{{token}}` is kept whole.
 */
function percentDecodeCredential(text: string): string {
	let valid = true;
	const decoded = mapOutsideTokens(text, (plain) =>
		plain.replace(PERCENT_ESCAPES, (run) => {
			const bytes = Uint8Array.from(run.match(/%(..)/g) ?? [], (escape) =>
				parseInt(escape.slice(1), 16)
			);
			try {
				return strictUtf8.decode(bytes);
			} catch {
				valid = false;
				return run;
			}
		})
	);
	return valid ? decoded : text;
}

/** A URL's user info: the credentials it sends, and the password as written. */
interface UrlCredentials {
	username: string;
	password: string;
	writtenPassword: string;
}

/** Split at the first `:` outside a token; a user info with no `:` has an empty password. */
function parseUserInfo(userInfo: string): UrlCredentials | null {
	if (userInfo === "") return null;
	const colon = maskTokens(userInfo).indexOf(":");
	const writtenPassword = colon === -1 ? "" : userInfo.slice(colon + 1);
	return {
		username: percentDecodeCredential(colon === -1 ? userInfo : userInfo.slice(0, colon)),
		password: percentDecodeCredential(writtenPassword),
		writtenPassword,
	};
}

const URL_CREDENTIALS_DROPPED_NOTE =
	"The URL's credentials were dropped because the request's own authorization wins, as Vayu sends.";

/**
 * A secret as it can appear in a URL: as written, as substituted into URL text
 * (`encodeAtUrlComponent`, the rule compose and the "Sends" line apply to a
 * `{{token}}` in the host, the path, the query or the fragment, each by its own
 * set, which leaves `&` and `=` raw), as a query row's value
 * (`encodeQueryComponent`) and as `encodeURIComponent` writes it. The raw
 * value alone would miss `a b&c` sitting there as `a%20b&c`, and a path
 * writes `{` and a backtick where a query leaves them. In the host the composed
 * URL lowercases and punycodes, so a secret there is matched in that form too
 * (#2591); a secret that is only part of a label is rewritten with the whole
 * label by punycode and is not matched. In a JSON-RPC or GraphQL body the
 * engine's envelope is built first, which writes a quote, backslash or newline
 * in the secret as a JSON escape, so that spelling is matched too (#3198). A
 * GraphQL GET carries the document in the URL escaped as `curl_easy_escape`
 * does, which differs from `encodeURIComponent` on `!'()*`, and an envelope's
 * `variables` are escaped after their JSON spelling (#3211).
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
		encodeHost(secret),
		JSON.stringify(secret).slice(1, -1),
		curlEscape(secret),
		curlEscape(JSON.stringify(secret).slice(1, -1)),
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

type BodyField = NonNullable<SnippetBody["fields"]>[number];

function multipartPart(field: BodyField): PreparedPart {
	if (field.type === "file") {
		return {
			kind: "file",
			key: field.key,
			path: field.src ?? "",
			fileName: field.fileName,
			contentType: field.contentType,
		};
	}
	const declared = field.contentType?.trim();
	return {
		kind: "text",
		key: field.key,
		value: field.value,
		...(declared ? { contentType: declared } : {}),
	};
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
		if (enabled.length === 0) return undefined;
		// urlencoded has no file form on the wire, so a stray file row there is
		// not a part any snippet could express - the engine refuses it too.
		if (shape.mode === "x-www-form-urlencoded") {
			return {
				kind: "urlencoded",
				fields: enabled.map((f): [string, string] => [f.key, f.value]),
			};
		}
		return { kind: "form-data", parts: enabled.map(multipartPart) };
	}

	if (!shape.content) return undefined;
	// Before masking (the caller masks the result), as the engine completes the
	// body before it leaves: a secret inside the envelope is still found.
	return { kind: "raw", content: wireBodyContent(shape.mode, shape.content) };
}

/**
 * The query string a GraphQL GET carries its document as, or undefined for any
 * other request and for a GraphQL body the engine keeps in the body frame
 * (`graphql_url_transport`, `engine/src/http/form_body.cpp`).
 */
function graphqlUrlTransport(method: string, body: unknown): string | undefined {
	if (method !== "GET" || typeof body !== "object" || body === null) return undefined;
	const { mode, content } = body as SnippetBody;
	return mode === "graphql" && content ? graphqlGetQuery(content) : undefined;
}

/**
 * The body with every string a secret could sit in run through the masker - a
 * file part's or a binary body's path included, since a `{{token}}`-built path would otherwise
 * print the secret the rest of the snippet hides.
 */
function maskedBody(body: PreparedBody, mask: (text: string) => string): PreparedBody {
	if (body.kind === "raw") return { kind: "raw", content: mask(body.content) };
	if (body.kind === "binary") return { kind: "binary", path: mask(body.path) };
	if (body.kind === "urlencoded") {
		return {
			kind: "urlencoded",
			fields: body.fields.map(([k, v]): [string, string] => [k, mask(v)]),
		};
	}
	return {
		kind: "form-data",
		parts: body.parts.map((part): PreparedPart =>
			part.kind === "text"
				? { ...part, value: mask(part.value) }
				: { ...part, path: mask(part.path) }
		),
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

/** The request's header lines in the order they were given, a repeat repeated (issue #2466). */
function headerPairs(headers: SnippetRequest["headers"]): Array<[string, string]> {
	return headerLinesOf(headers).map(({ name, value }): [string, string] => [name, value]);
}

/** How the engine joins repeated `Cookie` rows into the one line it sends (#2788). */
const COOKIE_SEPARATOR = "; ";

/** `has_header_value`: a value with a non-`std::isspace` character is not blank. */
const HAS_HEADER_VALUE = /[^ \t\n\v\f\r]/;

/**
 * Whether the engine reads the value as blank (empty or only whitespace), which
 * it sends as an empty header on the wire (issue #3220). A curl snippet has to
 * spell such a row `Name;`: `Name: ` is curl's "remove this header".
 */
export function isBlankHeaderValue(value: string): boolean {
	return !HAS_HEADER_VALUE.test(value);
}

/** RFC 9110 optional whitespace, space and tab: the edge `trim_optional_whitespace` strips. */
const EDGE_WHITESPACE = /^[ \t]+|[ \t]+$/g;

/**
 * The one `Cookie` line the engine builds from the typed rows
 * (`typed_cookie_value`, `engine/src/http/event_loop/curl_utils.cpp`): a row
 * with nothing that reaches the wire is skipped, each other row is trimmed of
 * its edge whitespace, and the rest are joined with "; ". Empty when no row
 * is sent, in which case the engine writes no `Cookie` line at all.
 */
function typedCookieValue(rows: readonly string[]): string {
	return rows
		.filter((value) => HAS_HEADER_VALUE.test(value))
		.map((value) => value.replace(EDGE_WHITESPACE, ""))
		.join(COOKIE_SEPARATOR);
}

/**
 * Join repeated `Cookie` rows into one, leaving every other repeat alone.
 *
 * The engine sends the typed `Cookie` rows as a single line
 * (`typedCookieValue`) while any other repeated header goes out as separate
 * lines. curl and HTTPie can repeat a header, so they fold only this one - and
 * need no note, because the folded line is what Vayu sends. The line sits where
 * the first `Cookie` row was and keeps that row's spelling; when no row reaches
 * the wire there is no line.
 */
export function foldRepeatedCookies(
	headers: ReadonlyArray<[string, string]>
): Array<[string, string]> {
	const isCookie = ([name]: [string, string]) => name.toLowerCase() === "cookie";
	const first = headers.findIndex(isCookie);
	if (first === -1) return [...headers];
	const joined = typedCookieValue(headers.filter(isCookie).map(([, value]) => value));
	return headers.flatMap((row, index): Array<[string, string]> => {
		if (!isCookie(row)) return [row];
		return index === first && joined !== "" ? [[row[0], joined]] : [];
	});
}

/**
 * Fold every header a client with one value per name cannot repeat into a single
 * entry, and say so. The entry sits where the name first appeared, keeps that
 * row's spelling and joins the values with ", " - `Cookie` as the engine does
 * (`typedCookieValue`) - and the note names each name that was joined, because
 * Vayu sends those rows as separate lines - except `Cookie`, which it sends as
 * the same "; " join (issue #2788).
 *
 * For `fetch`, `requests` and `Invoke-RestMethod`, whose header map is a
 * dictionary. curl and HTTPie repeat a header and fold only `Cookie`
 * (`foldRepeatedCookies`).
 */
export function foldRepeatedHeaders(
	headers: ReadonlyArray<[string, string]>,
	client: string
): { headers: Array<[string, string]>; notes: string[] } {
	const folded = new Map<string, { name: string; values: string[] }>();
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		const entry = folded.get(key);
		if (entry) entry.values.push(value);
		else folded.set(key, { name, values: [value] });
	}

	const notes: string[] = [];
	const out: Array<[string, string]> = [];
	for (const [key, { name, values }] of folded) {
		const isCookie = key === "cookie";
		if (values.length > 1) {
			const separator = isCookie ? COOKIE_SEPARATOR : ", ";
			const sent = isCookie
				? "Vayu sends them joined the same way"
				: "Vayu sends them as separate lines";
			notes.push(
				`${client} holds one value per header name, so the ${values.length} ${name} lines are joined into one with "${separator}"; ${sent}.`
			);
		}
		const value = isCookie ? typedCookieValue(values) : values.join(", ");
		if (!isCookie || value !== "") out.push([name, value]);
	}
	return { headers: out, notes };
}

/** A redirect cap a client could be told: a whole number of hops, zero included. */
function validMaxRedirects(value: number | undefined): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The deadline to state, or null. Null and absent both mean the request names
 * none, so the engine's `defaultTimeout` decides at send time and a snippet
 * has nothing true to say; a value that is not a positive number is treated the
 * same way instead of being written into a command as `--max-time NaN`.
 */
function validTimeoutMs(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Milliseconds as the seconds a client flag takes, decimals kept (2500 is 2.5). */
export function timeoutSeconds(ms: number): number {
	return ms / 1000;
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
 *
 * The URL's `user:pass@` is taken off the URL for every target. It is Basic
 * credentials only where nothing else authorizes the request: libcurl sends it
 * unless an `Authorization` header is set, which any header-writing auth or a
 * typed one is, and then it is dropped with a note. The password is masked as a
 * secret whether it is kept or not.
 */
export function prepareRequest(
	request: SnippetRequest,
	options: CodegenOptions = {}
): PreparedRequest {
	const notes: string[] = [];

	// Path variables first, as the engine composes them (issue #1764), so a
	// query-located API key appended below lands after the substituted path.
	// Raw under `disableUrlEncoding` (issue #1765), as the engine substitutes.
	// Then the URL written as Send puts it on the wire (issue #2465): the
	// `{{token}}`s stay (a snippet is templated), the literal text around them
	// is encoded and the host lowercased, so the snippet carries the line Vayu
	// sends and not the one typed.
	const encode = request.disableUrlEncoding !== true;
	let url = resolveUrlTemplate(
		substitutePathVariables(request.url ?? "", request.params ?? [], undefined, { encode }),
		(text) => text,
		{ encode }
	);
	const userInfo = splitUrlUserInfo(url);
	const urlCredentials = userInfo ? parseUserInfo(userInfo.userInfo) : null;
	if (userInfo) url = userInfo.url;
	const headers = headerPairs(request.headers);
	let basicAuth: { username: string; password: string } | null = null;

	const auth = request.auth;
	const mode = auth ? asString(auth.mode) : "";
	const masker = createSecretMasker(
		[
			...(options.secrets ?? []),
			...(urlCredentials ? [urlCredentials.password, urlCredentials.writtenPassword] : []),
		],
		options.mask,
		apiKeyHeaderName(auth)
	);
	switch (mode) {
		case "":
		case "none":
		case "noauth":
			break;
		case "bearer": {
			// Trimmed, and no header at all when nothing is left, as the engine's
			// `apply_bearer` does (#3438).
			const token = trimCredential(asString(auth!.token));
			if (token && !carriesHeader(headers, "Authorization")) {
				headers.push(["Authorization", `Bearer ${token}`]);
			}
			break;
		}
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
			// Trimmed as the engine trims both halves before placing either.
			const key = trimCredential(asString(auth!.key));
			const value = trimCredential(asString(auth!.value));
			if (key) {
				if (asString(auth!.in) === "query") url = appendQueryParam(url, key, value, encode);
				else if (!carriesHeader(headers, key)) headers.push([key, value]);
			}
			break;
		}
		default:
			notes.push(
				`This request uses ${unreproducibleAuthName(mode)}, so the snippet carries no credentials from it.`
			);
	}

	if (urlCredentials) {
		// OAuth 2.0 writes `Authorization` at send time, so it wins though no
		// header is in the snippet.
		const requestAuthWins =
			basicAuth !== null || mode === "oauth2" || carriesHeader(headers, "Authorization");
		if (requestAuthWins) notes.push(URL_CREDENTIALS_DROPPED_NOTE);
		else basicAuth = { username: urlCredentials.username, password: urlCredentials.password };
	}

	const method = (request.method || "GET").toUpperCase();
	// A GraphQL GET sends its document in the URL and no body (#3211), after
	// every parameter auth added, as the engine appends it last.
	const graphqlQuery = graphqlUrlTransport(method, request.body);
	if (graphqlQuery !== undefined) url = urlWithQuery(url, graphqlQuery);
	const body = graphqlQuery === undefined ? normalizeBody(request.body) : undefined;
	// Absent means following: the engine's own default (issue #1445), unlike
	// curl's, which is why the flag is worth emitting on the common case
	// rather than only when it departs from one.
	const followRedirects = request.followRedirects !== false;

	// After auth, so a header the request carries under any name still counts as
	// declared; and only when there is a body, because a mode with nothing in it
	// sends none - the engine's `has_wire_body` gate, which `normalizeBody`
	// applied by returning undefined and a GraphQL GET applied by moving its
	// document into the URL.
	const withContentType = body ? withImpliedContentType(headers, request.body) : headers;

	// Mask last, over everything at once, so a credential and a secret variable
	// that happen to hold the same value are hidden by the same pass.
	const maskedBasic = basicAuth
		? { username: masker.apply(basicAuth.username), password: masker.apply(basicAuth.password) }
		: null;

	return {
		method,
		url: masker.apply(url),
		headers: withContentType.map(([k, v]): [string, string] => [k, masker.applyHeader(k, v)]),
		basicAuth: maskedBasic,
		body: body ? maskedBody(body, masker.apply) : undefined,
		stream: request.stream === true,
		// Absent means verifying: the engine's default, and the safe reading of
		// a caller that never set it.
		verifySSL: request.verifySSL !== false,
		followRedirects,
		maxRedirects: followRedirects ? validMaxRedirects(request.maxRedirects) : null,
		timeoutMs: validTimeoutMs(request.timeout),
		httpVersion: isHttpVersion(request.httpVersion)
			? request.httpVersion
			: DEFAULT_HTTP_VERSION,
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
 * Left as written: `isSensitiveHeaderName` trims both names it compares.
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
			return [trimCredential(asString(auth.token))];
		case "basic":
			return [asString(auth.password)];
		case "apikey":
			return [trimCredential(asString(auth.value))];
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
