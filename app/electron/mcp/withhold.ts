/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file withhold.ts
 * @brief What an MCP read hands an agent in place of a secret (#1805): a
 *        variable flagged `secret`, an auth credential, a cookie value, the
 *        credentials in a proxy URL, the credentials a saved request carries in
 *        its URL and Params rows (#1837). Withheld unless the user turns on
 *        `revealSecretsToAgents`.
 *
 * Withheld is stated, never silent - the `projectOAuth2Token` precedent. An
 * agent that finds no value and is not told why concludes the data is empty or
 * broken, and acts on that. So a withheld variable or cookie carries
 * `valueWithheld: true`, an auth member `<member>Withheld: true`, a credential
 * row (a Postman attribute, a header or a saved request's Params row)
 * `valueWithheld: true` on the row, and a config or proxy URL
 * `credentialsWithheld: true`. A saved request's own `url` is the one value
 * with no room for a marker: its userinfo password is dropped and a credential
 * query or fragment value is emptied in place (`api_key=`), as the engine's
 * `redact_url_credentials` does for an export, and its Params row says which.
 *
 * What goes through the row projections is what is *stored*: environments,
 * globals, collections, requests and saved examples as the read tools and the
 * `vayu://` resources answer them, the cookie jars, and the config table
 * (`update_engine_config`'s echo included). A write tool's own answer, which
 * echoes the stored row, goes through the same projection as the read of that
 * row: writing does not grant reading.
 *
 * What a run *recorded* - a trace, a report, a sample, a run row, an inbox
 * capture - goes through {@link runOutputShape} instead (#1809). A request
 * that references a secret still sends it, so the record of what was sent
 * carries the resolved value in whatever encoding it went out in; that value
 * is masked in place with the engine's `<redacted>` marker, the rule the engine
 * applies to a run's config snapshot (#1803), so the record keeps its shape.
 */

import type { McpSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";
import { withValue } from "./variable-origins.js";

/** The one setting this module reads off a tool context. */
interface RevealContext {
	config: Pick<McpSafetyConfig, "revealSecretsToAgents">;
}

type Projection = (value: unknown) => unknown;

/** Where the setting lives, in the words every withholding description uses. */
const REVEAL_SETTING = "Reveal secrets to agents (Vayu Settings → MCP)";

/** What a read carrying variables says about the secret ones. */
export const WITHHELD_VARIABLE_SENTENCE = `A variable flagged \`secret\` comes back with \`valueWithheld: true\` in place of its value unless the user has turned on ${REVEAL_SETTING}; a request that references it still sends with it, because the engine resolves it.`;

/** What a read carrying auth blocks says about the credentials in them. */
export const WITHHELD_AUTH_SENTENCE = `An auth credential (a token, password, client secret or key) comes back as \`<member>Withheld: true\` in place of its value, and a credential row in a Postman import's \`postman\` source as \`valueWithheld: true\` on the row, unless the user has turned on ${REVEAL_SETTING}; a pure {{variable}} reference is shown as written. A block carrying such a marker is refused as \`auth\` by every tool that takes one, because it holds no credential.`;

/** What a read carrying header rows says about the credential-bearing ones. */
export const WITHHELD_HEADER_SENTENCE = `A header row whose name carries a credential (\`Authorization\`, \`Proxy-Authorization\`, \`Cookie\`, \`Set-Cookie\`, \`X-Api-Key\`, \`X-Auth-Token\`, \`X-CSRF-Token\`, or the header the request's API-key auth names) comes back with \`valueWithheld: true\` in place of its value unless the user has turned on ${REVEAL_SETTING}; an empty value or a pure {{variable}} reference is shown as written.`;

/** What a read carrying saved requests says about the credentials in a URL and in Params rows. */
export const WITHHELD_URL_SENTENCE = `A saved request's \`url\` has the password of \`user:password@\` dropped and the value of a credential query or fragment parameter (\`api_key\`, \`token\`, \`signature\`, or the one the request's API-key auth places in the query) emptied in place (\`?api_key=&page=2\`), and a \`params\` row naming one comes back with \`valueWithheld: true\` in place of its value, unless the user has turned on ${REVEAL_SETTING}; an empty value or a pure {{variable}} reference is shown as written.`;

/** The marker a masked value reads as in run output: the engine's `kRedactedMarker`. */
export const REDACTED_MARKER = "<redacted>";

/** What a read of run output says about the secrets the run sent. */
export const WITHHELD_RUN_OUTPUT_SENTENCE = `Unless the user has turned on ${REVEAL_SETTING}, every secret variable's value and every literal credential a stored collection's or request's auth holds reads \`${REDACTED_MARKER}\` in this result (4 bytes or longer, raw, percent-encoded, JSON- or XML-escaped), and so does the value of a credential-bearing header (\`Authorization\`, \`Proxy-Authorization\`, \`Cookie\`, \`Set-Cookie\`, \`X-Api-Key\`, \`X-Auth-Token\`, \`X-CSRF-Token\`, or one an API-key auth names), in a header map and on a \`rawRequest\` header line, request and response alike. Everything else is kept - the shape, the order and the engine's size fields - and the request itself was sent with the real values. If a lookup the masking reads those values from fails, the call answers an error naming it and none of the result.`;

/** What `get_mock_activity` says about the paths a mock server logged. */
export const WITHHELD_MOCK_ACTIVITY_SENTENCE = `Unless the user has turned on ${REVEAL_SETTING}, every secret variable's value in an entry (the path a client sent can carry one) reads \`${REDACTED_MARKER}\`, as in run output; the rest of the entry is kept.`;

/** What `start_load_run` says about its confirmation preview's planned run. */
export const WITHHELD_PLANNED_RUN_SENTENCE = `Unless the user has turned on ${REVEAL_SETTING}, the preview's planned run is the composed request as the run will record it: every secret's value reads \`${REDACTED_MARKER}\` and the \`auth\` block's credentials read \`<member>Withheld: true\`.`;

/** What `diff_spec` says about a stored request's credential headers. */
export const WITHHELD_HEADER_DIFF_SENTENCE = `A \`headers\` change whose current value names a credential-bearing header (\`Authorization\`, \`Cookie\`, \`X-Api-Key\` and the rest of the shared list) with a value comes back with \`currentWithheld: true\` in place of \`current\` unless the user has turned on ${REVEAL_SETTING}.`;

/** What `get_cookies` says about cookie values. */
export const WITHHELD_COOKIE_SENTENCE = `Each cookie value comes back as \`valueWithheld: true\` unless the user has turned on ${REVEAL_SETTING}.`;

/** What `get_engine_config` says about proxy URLs. */
export const WITHHELD_CONFIG_SENTENCE = `A URL entry's credentials (\`proxyUrl\`'s user:password) are stripped, with \`credentialsWithheld: true\` on the entry, unless the user has turned on ${REVEAL_SETTING}.`;

/** What `diagnose_connection` says about the proxy URL it reports. */
export const WITHHELD_DIAGNOSE_SENTENCE = `The proxy's URL has its credentials (user:password) stripped, with \`credentialsWithheld: true\` on \`proxy\`, unless the user has turned on ${REVEAL_SETTING}.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * `withhold` as a `callEngine` shape, or the identity when the user chose to
 * reveal secrets to agents.
 */
export function secretsShape(ctx: RevealContext, withhold: Projection): Projection {
	return (value) => (ctx.config.revealSecretsToAgents ? value : withhold(value));
}

// --- Variables ----------------------------------------------------------------

/** `secret` is `=== true`, as `buildVariableOrigins` reads it: anything else is not a secret. */
function withholdVariable(def: unknown): unknown {
	if (!isRecord(def) || def.secret !== true) return def;
	const { value, ...rest } = def;
	return { ...rest, ...withValue(value, true) };
}

function withholdVariableBag(bag: unknown): unknown {
	if (!isRecord(bag)) return bag;
	return Object.fromEntries(
		Object.entries(bag).map(([name, def]) => [name, withholdVariable(def)])
	);
}

// --- Auth ---------------------------------------------------------------------

/**
 * The auth members that hold a credential rather than describe one, across
 * every mode Vayu stores. The engine's `SECRET_AUTH_KEYS`
 * (`engine/src/core/vayu_extensions.cpp`), which blanks the same set when a
 * collection is exported.
 */
const CREDENTIAL_AUTH_MEMBERS: ReadonlySet<string> = new Set([
	"token",
	"password",
	"value",
	"clientSecret",
	"secretKey",
	"accessKey",
	"sessionToken",
	"accessToken",
	"refreshToken",
	"idToken",
	"secret",
	"authKey",
	"consumerSecret",
	"tokenSecret",
	"clientToken",
	"privateKey",
	"code_verifier",
]);

/**
 * The wire names a credential goes by in a Postman OAuth 2.0 block's extra
 * request parameters (`tokenRequestParams`, `authRequestParams`,
 * `refreshRequestParams`: `{key, value, ...}` rows), beside the members above.
 * The engine's `SECRET_PARAM_KEYS`, beside `SECRET_AUTH_KEYS`.
 */
const CREDENTIAL_PARAM_KEYS: ReadonlySet<string> = new Set([
	"client_secret",
	"client_assertion",
	"code_verifier",
	"refresh_token",
	"access_token",
	"id_token",
	"password",
	"assertion",
]);

const WITHHELD_SUFFIX = "Withheld";

/** The member an auth block carries in place of @p member once it is withheld. */
function withheldMarker(member: string): string {
	return `${member}${WITHHELD_SUFFIX}`;
}

/**
 * Whether @p text is one `{{variable}}` reference and nothing else - the
 * engine's `is_variable_reference`. Such a value names where the secret lives
 * without being it, so it is shown: the variable it names is withheld on its
 * own terms.
 */
function isVariableReference(text: string): boolean {
	const match = /^ *\{\{([^{}]*)\}\} *$/.exec(text);
	return match !== null && match[1].trim() !== "";
}

function holdsCredential(value: unknown): boolean {
	return typeof value === "string" && value !== "" && !isVariableReference(value);
}

function withholdCredentialMembers(block: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [member, value] of Object.entries(block)) {
		if (CREDENTIAL_AUTH_MEMBERS.has(member) && holdsCredential(value)) {
			out[withheldMarker(member)] = true;
		} else {
			out[member] = value;
		}
	}
	return out;
}

function withholdRowValue(row: Record<string, unknown>): Record<string, unknown> {
	const { value, ...rest } = row;
	return { ...rest, ...withValue(value, true) };
}

function namesCredentialParam(key: unknown): boolean {
	return (
		typeof key === "string" &&
		(CREDENTIAL_AUTH_MEMBERS.has(key) || CREDENTIAL_PARAM_KEYS.has(key))
	);
}

/** `{key, value}` rows, each whose key names a credential with its value withheld. */
function withholdParamRows(rows: unknown): unknown {
	if (!Array.isArray(rows)) return rows;
	return rows.map((row) =>
		isRecord(row) && namesCredentialParam(row.key) && holdsCredential(row.value)
			? withholdRowValue(row)
			: row
	);
}

/** One v2.1 `{key, value, type}` attribute: a credential, or parameter rows to walk. */
function withholdPostmanAttribute(attribute: unknown): unknown {
	if (!isRecord(attribute) || typeof attribute.key !== "string") return attribute;
	if (CREDENTIAL_AUTH_MEMBERS.has(attribute.key)) {
		return holdsCredential(attribute.value) ? withholdRowValue(attribute) : attribute;
	}
	return Array.isArray(attribute.value)
		? { ...attribute, value: withholdParamRows(attribute.value) }
		: attribute;
}

/** One Postman auth type's detail: v2.1's attribute array, or v2.0's `{name: value}` object. */
function withholdPostmanDetail(detail: unknown): unknown {
	if (Array.isArray(detail)) return detail.map(withholdPostmanAttribute);
	if (!isRecord(detail)) return detail;
	return Object.fromEntries(
		Object.entries(withholdCredentialMembers(detail)).map(([name, value]) => [
			name,
			withholdParamRows(value),
		])
	);
}

/**
 * A Postman import's `postman` source (`{type, <type>: detail}`), which keeps
 * the auth as Postman wrote it, raw credentials included. The engine's
 * `redact_postman_auth`.
 */
function withholdPostmanAuth(source: unknown): unknown {
	if (!isRecord(source)) return source;
	return Object.fromEntries(
		Object.entries(source).map(([member, value]) => [
			member,
			member === "type" ? value : withholdPostmanDetail(value),
		])
	);
}

/**
 * An auth block with its credentials withheld: the flat modes keep theirs at
 * the top level (`bearer.token`, `basic.password`, `apikey.value`), the rest
 * under `config` (OAuth 2.0's `clientSecret`, AWS's key pair, ...), and a
 * Postman import also under `postman`. The engine's `redact_level`.
 */
function withholdAuth(auth: unknown): unknown {
	if (!isRecord(auth)) return auth;
	const outer = withholdCredentialMembers(auth);
	return {
		...outer,
		...(isRecord(outer.config) ? { config: withholdCredentialMembers(outer.config) } : {}),
		...("postman" in outer ? { postman: withholdPostmanAuth(outer.postman) } : {}),
	};
}

/**
 * The values @p withheld - a withholding projection of @p original, which
 * keeps every key and array position - holds a marker in place of: `<member>`
 * beside each new `<member>Withheld: true`, `value` beside a row's
 * `valueWithheld: true`. A marker @p original already carried replaced nothing.
 */
function valuesWithheldBy(original: unknown, withheld: unknown): string[] {
	if (Array.isArray(original) && Array.isArray(withheld)) {
		return original.flatMap((item, at) => valuesWithheldBy(item, withheld[at]));
	}
	if (!isRecord(original) || !isRecord(withheld)) return [];
	return Object.entries(withheld).flatMap(([key, value]) => {
		const isNewMarker =
			value === true && key.endsWith(WITHHELD_SUFFIX) && original[key] === undefined;
		if (!isNewMarker) return valuesWithheldBy(original[key], value);
		const replaced = original[key.slice(0, -WITHHELD_SUFFIX.length)];
		return typeof replaced === "string" ? [replaced] : [];
	});
}

/**
 * The literal credentials an auth block holds: every member {@link withholdAuth}
 * withholds (the same set {@link withheldAuthMembers} names on the way back),
 * so an empty value or a lone `{{variable}}` is not one.
 */
function authCredentialValues(auth: unknown): string[] {
	return valuesWithheldBy(auth, withholdAuth(auth));
}

function memberMarkers(block: Record<string, unknown>): string[] {
	return [...CREDENTIAL_AUTH_MEMBERS]
		.map(withheldMarker)
		.filter((marker) => block[marker] !== undefined);
}

/** `valueWithheld` rows under @p path, through parameter rows nested in an attribute's value. */
function rowMarkers(rows: unknown, path: string): string[] {
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		if (!isRecord(row)) return [];
		const at = `${path}[${String(row.key)}]`;
		const own = row.valueWithheld === undefined ? [] : [`${at}.valueWithheld`];
		return [...own, ...rowMarkers(row.value, at)];
	});
}

function postmanMarkers(source: unknown): string[] {
	if (!isRecord(source)) return [];
	return Object.entries(source).flatMap(([type, detail]) => {
		if (type === "type") return [];
		const path = `postman.${type}`;
		if (!isRecord(detail)) return rowMarkers(detail, path);
		return [
			...memberMarkers(detail).map((marker) => `${path}.${marker}`),
			...Object.entries(detail).flatMap(([name, value]) =>
				rowMarkers(value, `${path}.${name}`)
			),
		];
	});
}

/**
 * The withheld markers in an auth block an agent passed back: top level,
 * `config`, and a Postman import's `postman` source. A block read with its
 * credentials withheld and written back would store, or send, no credential
 * in their place.
 */
export function withheldAuthMembers(auth: Record<string, unknown>): string[] {
	return [
		...memberMarkers(auth),
		...(isRecord(auth.config) ? memberMarkers(auth.config) : []),
		...postmanMarkers(auth.postman),
	];
}

// --- Headers ------------------------------------------------------------------

/**
 * The header names that hold a credential whatever their value is: a header
 * typed straight into a request is no variable, so the name is the only signal.
 * `app/src/lib/sensitive-headers.ts`'s list, which this module cannot import
 * (`electron/` may not reach into `src/`); both are pinned to the engine's by
 * `sensitiveHeaderNames` in `engine/tests/fixtures/log-redaction-conformance.json`
 * (`withhold.conformance.test.ts`).
 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
];

/**
 * The header name an API-key auth declares, whatever its `in` says: the
 * engine's `api_key_header_names` (`engine/src/utils/json.cpp`), which reads
 * the key off any `apikey` block, so the two mask the same header. The one
 * sensitive name no list can hold.
 */
function apiKeyHeaderName(auth: unknown): string | undefined {
	if (!isRecord(auth) || auth.mode !== "apikey") return undefined;
	return typeof auth.key === "string" ? auth.key.trim().toLowerCase() : undefined;
}

/**
 * Whether a header named @p name carries a credential in @p value: a name on
 * the shared list or one of @p apiKeyHeaders (lower-cased), and a value that
 * holds one. One rule for a stored row, a recorded header map and a wire line.
 */
function isCredentialHeader(
	name: unknown,
	value: unknown,
	apiKeyHeaders: readonly string[]
): boolean {
	if (typeof name !== "string" || !holdsCredential(value)) return false;
	const folded = name.trim().toLowerCase();
	if (folded === "") return false;
	return SENSITIVE_HEADER_NAMES.includes(folded) || apiKeyHeaders.includes(folded);
}

function isSensitiveHeaderRow(row: unknown, apiKeyHeader: string | undefined): boolean {
	return (
		isRecord(row) && isCredentialHeader(row.key, row.value, apiKeyHeader ? [apiKeyHeader] : [])
	);
}

/**
 * `{key, value, enabled}` header rows with each credential-bearing row's value
 * withheld, disabled rows included: a row switched off is one click from sent.
 * @p auth is the owning request's, for the API-key header; an example has none.
 */
function withholdHeaderRows(headers: unknown, auth: unknown): unknown {
	if (!Array.isArray(headers)) return headers;
	const apiKeyHeader = apiKeyHeaderName(auth);
	return headers.map((row) =>
		isSensitiveHeaderRow(row, apiKeyHeader) ? withholdRowValue(row) : row
	);
}

// --- Request URL and Params --------------------------------------------------

/**
 * The query-parameter and Params-row names that hold a credential whatever
 * their value is: the engine's `is_secret_param_name`
 * (`engine/src/core/vayu_extensions.cpp`), which is the shared secret-field set
 * (`engine/include/vayu/utils/log_redact.hpp`) less `code`, plus
 * `EXTRA_SECRET_PARAM_NAMES`. `code` (`?code=US`) and `key` (a cache or sort
 * key) are data far more often than a credential, so neither is on it; the key
 * an API-key auth places in the query is added per request. Pinned to
 * `sensitiveParamNames` in `engine/tests/fixtures/log-redaction-conformance.json`
 * (`withhold.conformance.test.ts`).
 */
export const SENSITIVE_PARAM_NAMES: readonly string[] = [
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"www-authenticate",
	"proxy-authenticate",
	"authentication-info",
	"token",
	"access_token",
	"refresh_token",
	"client_secret",
	"password",
	"apikey",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
	"passphrase",
	"api_key",
	"id_token",
	"code_verifier",
	"private_key",
	"secret_access_key",
	"secretaccesskey",
	"session_token",
	"api-key",
	"secret",
	"auth_token",
	"signature",
	"sig",
	"x-amz-signature",
	"x-amz-security-token",
	"client_assertion",
	"assertion",
];

const SENSITIVE_PARAM_NAME_SET: ReadonlySet<string> = new Set(SENSITIVE_PARAM_NAMES);

/** ASCII-only fold, the engine's `ascii_lower`: `toLowerCase` would also fold the Kelvin sign into `k`. */
function asciiLower(text: string): string {
	return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * The query-parameter name an API-key auth placed `in: "query"` sends its key
 * under: the engine's `apikey_names (auth, true)`. As written, not trimmed, as
 * the engine matches it; the header counterpart is {@link apiKeyHeaderName}.
 */
function apiKeyParamName(auth: unknown): string | undefined {
	if (!isRecord(auth) || auth.mode !== "apikey" || auth.in !== "query") return undefined;
	return typeof auth.key === "string" && auth.key !== "" ? auth.key : undefined;
}

/**
 * Whether a parameter named @p name carries a credential: the request's own
 * API-key name, or one on {@link SENSITIVE_PARAM_NAMES}. Whole name, no
 * trimming and no percent-decoding, as the engine matches it.
 */
function isSecretParamName(name: string, apiKeyParam: string | undefined): boolean {
	const folded = asciiLower(name);
	if (apiKeyParam !== undefined && folded === asciiLower(apiKeyParam)) return true;
	return SENSITIVE_PARAM_NAME_SET.has(folded);
}

/**
 * `{key, value, enabled}` Params rows with each credential's value withheld,
 * disabled rows included. @p auth is the owning request's, for the API-key
 * name placed in the query.
 */
function withholdRequestParamRows(params: unknown, auth: unknown): unknown {
	if (!Array.isArray(params)) return params;
	const apiKeyParam = apiKeyParamName(auth);
	return params.map((row) =>
		isRecord(row) &&
		typeof row.key === "string" &&
		isSecretParamName(row.key, apiKeyParam) &&
		holdsCredential(row.value)
			? withholdRowValue(row)
			: row
	);
}

/** `name=value` with the value emptied, or @p pair as written when there is nothing to hide. */
function withholdQueryPair(pair: string, apiKeyParam: string | undefined): string {
	const equals = pair.indexOf("=");
	if (equals === -1 || equals + 1 === pair.length) return pair;
	if (!isSecretParamName(pair.slice(0, equals), apiKeyParam)) return pair;
	if (isVariableReference(pair.slice(equals + 1))) return pair;
	return pair.slice(0, equals + 1);
}

/** A `&`-separated query, or a fragment written as one, with each credential pair emptied. */
function withholdQuery(query: string, apiKeyParam: string | undefined): string {
	return query
		.split("&")
		.map((pair) => withholdQueryPair(pair, apiKeyParam))
		.join("&");
}

/**
 * The scheme-and-authority-and-path part of a URL with the password of its
 * userinfo dropped (`user:pass@host` becomes `user@host`). The engine's
 * `drop_userinfo_password`: a first segment holding spaces is a path, not an
 * authority, and the userinfo ends at the *last* `@`, so a password containing
 * one is still wholly dropped. Not {@link stripUserinfo}, which removes the user
 * too and takes any `@` in a path for one.
 */
function dropUserinfoPassword(head: string): string {
	const schemeEnd = head.indexOf("://");
	const hasScheme = schemeEnd !== -1 && !/[/ \t]/.test(head.slice(0, schemeEnd));
	const authorityStart = hasScheme ? schemeEnd + 3 : 0;
	const authorityEnd = head.indexOf("/", authorityStart);
	const authority = head.slice(authorityStart, authorityEnd === -1 ? undefined : authorityEnd);
	const at = authority.lastIndexOf("@");
	if (at === -1 || (!hasScheme && /[ \t]/.test(authority))) return head;
	const userinfo = authority.slice(0, at);
	const colon = userinfo.indexOf(":");
	if (colon === -1 || colon + 1 === userinfo.length) return head;
	if (isVariableReference(userinfo.slice(colon + 1))) return head;
	return (
		head.slice(0, authorityStart) + userinfo.slice(0, colon) + head.slice(authorityStart + at)
	);
}

/**
 * A saved request's `url` with its credentials blanked and every other byte
 * kept: the engine's `redact_url_credentials`, which an export applies to the
 * same field. The password of `user:password@host` is dropped (the user name
 * stays) and the value of a credential query or fragment parameter is emptied
 * (`?api_key=S&page=2` becomes `?api_key=&page=2`); a `{{variable}}` standing
 * alone is kept wherever it is. @p auth is the owning request's, for the API-key
 * name placed in the query. Anything but a string passes through.
 */
export function withholdRequestUrl(url: unknown, auth: unknown): unknown {
	if (typeof url !== "string") return url;
	const apiKeyParam = apiKeyParamName(auth);
	const fragmentAt = url.indexOf("#");
	const beforeFragment = fragmentAt === -1 ? url : url.slice(0, fragmentAt);
	const queryAt = beforeFragment.indexOf("?");
	let out = dropUserinfoPassword(
		queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt)
	);
	if (queryAt !== -1) out += `?${withholdQuery(beforeFragment.slice(queryAt + 1), apiKeyParam)}`;
	if (fragmentAt !== -1) out += `#${withholdQuery(url.slice(fragmentAt + 1), apiKeyParam)}`;
	return out;
}

// --- Rows ---------------------------------------------------------------------

/**
 * One stored row - an environment, the globals, a collection, a saved request
 * or one of its examples - with its `variables`, `auth`, credential-bearing
 * `headers`, and a request's credential-bearing `url` and `params` withheld.
 * Every other field passes through.
 */
export function withholdRowSecrets(row: unknown): unknown {
	if (!isRecord(row)) return row;
	return {
		...row,
		...("variables" in row ? { variables: withholdVariableBag(row.variables) } : {}),
		...("auth" in row ? { auth: withholdAuth(row.auth) } : {}),
		...("headers" in row ? { headers: withholdHeaderRows(row.headers, row.auth) } : {}),
		...("url" in row ? { url: withholdRequestUrl(row.url, row.auth) } : {}),
		...("params" in row ? { params: withholdRequestParamRows(row.params, row.auth) } : {}),
	};
}

/** {@link withholdRowSecrets} over a list; a non-list answer passes through untouched. */
export function withholdRowListSecrets(list: unknown): unknown {
	return Array.isArray(list) ? list.map(withholdRowSecrets) : list;
}

/**
 * `POST /reorder`'s answer - `{collections, requests}`, the whole rows a move
 * renumbered - with each list withheld as the read of its rows is.
 */
export function withholdReorderRows(answer: unknown): unknown {
	if (!isRecord(answer)) return answer;
	return {
		...answer,
		...("collections" in answer
			? { collections: withholdRowListSecrets(answer.collections) }
			: {}),
		...("requests" in answer ? { requests: withholdRowListSecrets(answer.requests) } : {}),
	};
}

// --- Cookies ------------------------------------------------------------------

function withholdCookie(cookie: unknown): unknown {
	if (!isRecord(cookie) || !("value" in cookie)) return cookie;
	const { value, ...rest } = cookie;
	return { ...rest, ...withValue(value, true) };
}

/** `GET /cookies` (`{scopes: [{environmentId, cookies}]}`) with every cookie value withheld. */
export function withholdCookieValues(answer: unknown): unknown {
	if (!isRecord(answer) || !Array.isArray(answer.scopes)) return answer;
	return {
		...answer,
		scopes: answer.scopes.map((scope) =>
			isRecord(scope) && Array.isArray(scope.cookies)
				? { ...scope, cookies: scope.cookies.map(withholdCookie) }
				: scope
		),
	};
}

// --- Engine config ------------------------------------------------------------

/**
 * A config key whose value is a URL - the engine logger's rule for a field
 * named `...url` / `...Url`. Today `proxyUrl` and `proxySystemUrl`, which curl
 * reads as `scheme://user:password@host:port`.
 */
const URL_CONFIG_KEY = /url$/i;

/**
 * Everything after an optional scheme up to the *last* `@`: the userinfo.
 * Greedy, so a password holding an unencoded `@` or `/` leaves nothing behind;
 * a value it over-strips loses part of a host, which is the safe failure.
 */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)?.*@/is;

/** `value` without its userinfo, or null when it carries none. */
function stripUserinfo(value: unknown): string | null {
	if (typeof value !== "string" || !URL_USERINFO.test(value)) return null;
	return value.replace(URL_USERINFO, "$1");
}

function withholdEntryCredentials(entry: unknown): unknown {
	if (!isRecord(entry) || typeof entry.key !== "string" || !URL_CONFIG_KEY.test(entry.key)) {
		return entry;
	}
	const stripped = stripUserinfo(entry.value);
	if (stripped === null) return entry;
	return { ...entry, value: stripped, credentialsWithheld: true };
}

/**
 * The config table (`GET /config`, and `POST /config`'s answer, which is the
 * same `entries` array) with the credentials in a URL entry withheld. The host
 * stays: which proxy is configured is what an agent diagnosing a network
 * failure needs, and the password is not.
 */
export function withholdConfigCredentials(answer: unknown): unknown {
	if (!isRecord(answer) || !Array.isArray(answer.entries)) return answer;
	return { ...answer, entries: answer.entries.map(withholdEntryCredentials) };
}

/**
 * A connection diagnosis (`POST /diagnostics/connection`) with the credentials
 * in `proxy.url` withheld. The engine reports the URL in force verbatim, so a
 * `manual` proxy's `user:password@` would reach the agent here as it does not
 * through {@link withholdConfigCredentials}.
 */
export function withholdDiagnoseCredentials(answer: unknown): unknown {
	if (!isRecord(answer) || !isRecord(answer.proxy)) return answer;
	const stripped = stripUserinfo(answer.proxy.url);
	if (stripped === null) return answer;
	return { ...answer, proxy: { ...answer.proxy, url: stripped, credentialsWithheld: true } };
}

// --- Spec diff ----------------------------------------------------------------

/**
 * The rows of a `rows_value` display (`engine/src/core/spec_diff.cpp`):
 * `N: key=value, key=value`, each name before its first `=`.
 */
const DISPLAY_ROW = /(?:^\d+: |, )([^=,]+)=([^,]*)/g;

function displaysCredentialHeader(display: unknown): boolean {
	if (typeof display !== "string") return false;
	return [...display.matchAll(DISPLAY_ROW)].some(([, name, value]) =>
		isCredentialHeader(name, value, [])
	);
}

function withholdChangedFields(entry: unknown): unknown {
	if (!isRecord(entry) || !Array.isArray(entry.fields)) return entry;
	return {
		...entry,
		fields: entry.fields.map((field) => {
			if (!isRecord(field) || field.field !== "headers") return field;
			if (!displaysCredentialHeader(field.current)) return field;
			const { current: _current, ...rest } = field;
			return { ...rest, currentWithheld: true };
		}),
	};
}

/**
 * `diff_spec`'s changed entries with each `headers` change whose current side -
 * the stored request's rows, as a display line - names a credential header
 * withheld whole. The line is the engine's lossy rendering (rows joined with
 * `, `, cut at 120 characters), so a value cannot be masked inside it without
 * a `Digest` header's later parameters reading as rows of their own.
 */
export function withholdSpecDiffChanges(changed: unknown): unknown {
	return Array.isArray(changed) ? changed.map(withholdChangedFields) : changed;
}

// --- Run output ---------------------------------------------------------------

/**
 * A secret shorter than this many bytes is not masked: the engine's
 * `kMinMaskedSecretLength`. Two or three characters recur in ordinary URL and
 * body text, so masking them would shred the record and withhold nothing a
 * guess could not recover.
 */
const MIN_MASKED_SECRET_BYTES = 4;

const utf8 = new TextEncoder();

function percentByte(byte: number): string {
	return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** RFC 3986's unreserved set, the one `url_encode` leaves as written. */
function isUnreservedByte(byte: number): boolean {
	return (
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		(byte >= 0x30 && byte <= 0x39) ||
		byte === 0x2d ||
		byte === 0x5f ||
		byte === 0x2e ||
		byte === 0x7e
	);
}

/** The engine's `vayu::utils::url_encode`: every byte outside the unreserved set as `%XX`. */
function urlEncode(text: string): string {
	let out = "";
	for (const byte of utf8.encode(text)) {
		out += isUnreservedByte(byte) ? String.fromCharCode(byte) : percentByte(byte);
	}
	return out;
}

/** Postman's query value set: the C0 controls, DEL and above, space `"` `#` `'` `<` `>` and `&`. */
const QUERY_VALUE_ASCII: ReadonlySet<number> = new Set(
	[...` "#'<>&`].map((char) => char.charCodeAt(0))
);

function percentEncodeQueryValue(text: string): string {
	let out = "";
	for (const byte of utf8.encode(text)) {
		out +=
			byte < 0x20 || byte > 0x7e || QUERY_VALUE_ASCII.has(byte)
				? percentByte(byte)
				: String.fromCharCode(byte);
	}
	return out;
}

/** Where a whole `{{...}}` token starting at @p at ends, or -1: the engine's `template_token_end`. */
function tokenEnd(text: string, at: number): number {
	if (!text.startsWith("{{", at)) return -1;
	for (let scan = at + 2; scan < text.length; scan++) {
		if (text[scan] === "{") return -1;
		if (text[scan] === "}") return text.startsWith("}}", scan) ? scan + 2 : -1;
	}
	return -1;
}

/**
 * The engine's `encode_query_component (text, QueryPart::Value)`, which a query
 * value composition writes goes through: Postman's set, a whole `{{...}}`
 * token kept. The renderer holds the same rule
 * (`src/modules/request-builder/utils/query-encoding.ts`), which `electron/`
 * cannot import; both are pinned to
 * `engine/tests/fixtures/query-encoding-conformance.json`.
 */
export function encodeQueryValue(text: string): string {
	let out = "";
	let plain = 0;
	for (let at = 0; at < text.length;) {
		const end = tokenEnd(text, at);
		if (end === -1) {
			at++;
			continue;
		}
		out += percentEncodeQueryValue(text.slice(plain, at)) + text.slice(at, end);
		plain = at = end;
	}
	return out + percentEncodeQueryValue(text.slice(plain));
}

/**
 * The engine's `escape_json_string_content`: only what JSON forbids raw is
 * rewritten, so `pa"ss` reads `pa\"ss` inside a JSON body's text. A JSON
 * string literal without its quotes is the same bytes, lowercase `\u00xx`
 * included.
 */
function escapeJsonStringContent(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

/**
 * The engine's `escape_xml_content`: `&`, `<` and `>` always, and a quote only
 * when it is @p quote, the delimiter of the attribute the value sits in (`""`
 * in character data).
 */
function escapeXmlContent(text: string, quote: "" | '"' | "'"): string {
	let out = "";
	for (const char of text) {
		if (char === "&") out += "&amp;";
		else if (char === "<") out += "&lt;";
		else if (char === ">") out += "&gt;";
		else if (char === '"' && quote === '"') out += "&quot;";
		else if (char === "'" && quote === "'") out += "&apos;";
		else out += char;
	}
	return out;
}

/**
 * Each secret value as a run's record can hold it - raw, `url_encode`'d,
 * query-encoded, JSON-escaped, and XML-escaped in character data and in each
 * attribute delimiter - longest first, so a secret that contains another is
 * masked whole rather than around the shorter one. The engine's
 * `masked_secret_forms`, form for form.
 */
export function secretForms(values: readonly string[]): string[] {
	const forms = new Set<string>();
	for (const value of values) {
		if (utf8.encode(value).length < MIN_MASKED_SECRET_BYTES) continue;
		forms.add(value);
		forms.add(urlEncode(value));
		forms.add(encodeQueryValue(value));
		forms.add(escapeJsonStringContent(value));
		for (const quote of ["", '"', "'"] as const) forms.add(escapeXmlContent(value, quote));
	}
	const bytes = (form: string) => utf8.encode(form).length;
	return [...forms].sort((a, b) => bytes(b) - bytes(a) || (a < b ? -1 : a > b ? 1 : 0));
}

/** What masks one run's output: the secret forms, and the API-key header names beside the list. */
export interface RunOutputRule {
	forms: readonly string[];
	apiKeyHeaders: readonly string[];
}

/** @p text with every occurrence of each form replaced, longest form first - the engine's `mask_secret_values`. */
function maskSecretForms(text: string, forms: readonly string[]): string {
	return forms.reduce((masked, form) => masked.split(form).join(REDACTED_MARKER), text);
}

/** The blank line between a wire frame's header block and its body. */
export const HEADER_BODY_SEPARATOR = "\r\n\r\n";

/** One `name: value` line of a header block, its line ending left outside the match. */
const WIRE_HEADER_LINE = /^([^:\r\n]+):([ \t]*)([^\r\n]*)(?=\r?$)/gm;

/**
 * A `rawRequest` wire frame with the value of each credential header line
 * masked. Only the header block is read - everything before the first blank
 * line, the split `cap_node_raw_request` makes - so a body line that happens to
 * read `Cookie: x` is the body's, and the request line has no name to match.
 */
function withholdWireHeaders(frame: string, apiKeyHeaders: readonly string[]): string {
	const end = frame.indexOf(HEADER_BODY_SEPARATOR);
	const head = end === -1 ? frame : frame.slice(0, end);
	const masked = head.replace(WIRE_HEADER_LINE, (line, name: string, gap: string, value) =>
		isCredentialHeader(name, value, apiKeyHeaders) ? `${name}:${gap}${REDACTED_MARKER}` : line
	);
	return end === -1 ? masked : masked + frame.slice(end);
}

/**
 * A recorded header set - the `{name: value}` map every trace, sample and
 * capture carries, or `{key, value}` rows - with each credential header's
 * value masked. Anything else passes through.
 */
function withholdHeaderSet(headers: unknown, apiKeyHeaders: readonly string[]): unknown {
	if (Array.isArray(headers)) {
		return headers.map((row) =>
			isRecord(row) && isCredentialHeader(row.key ?? row.name, row.value, apiKeyHeaders)
				? { ...row, value: REDACTED_MARKER }
				: row
		);
	}
	if (!isRecord(headers)) return headers;
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			isCredentialHeader(name, value, apiKeyHeaders) ? REDACTED_MARKER : value,
		])
	);
}

/** A member holding a header set: `headers`, a trace's `sentHeaders`, a response's `requestHeaders`. */
const HEADER_SET_MEMBER = /headers$/i;

function withholdRunMember(key: string, value: unknown, rule: RunOutputRule): unknown {
	const masked = withholdRunOutput(value, rule);
	if (HEADER_SET_MEMBER.test(key)) return withholdHeaderSet(masked, rule.apiKeyHeaders);
	if (key === "rawRequest" && typeof masked === "string") {
		return withholdWireHeaders(masked, rule.apiKeyHeaders);
	}
	return masked;
}

/**
 * Run output with every secret form in every string masked, and every
 * credential header's value in a header set or a `rawRequest` header block.
 * Keys are left alone, as the engine leaves them: a header or field *name* is
 * not a value. Numbers are never touched, so a size the engine reported still
 * describes what it measured.
 */
export function withholdRunOutput(value: unknown, rule: RunOutputRule): unknown {
	if (typeof value === "string") return maskSecretForms(value, rule.forms);
	if (Array.isArray(value)) return value.map((item) => withholdRunOutput(item, rule));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, member]) => [key, withholdRunMember(key, member, rule)])
	);
}

/** The engine reads a run-output projection is built from. */
type RunOutputClient = Pick<
	EngineClient,
	"getGlobals" | "listEnvironments" | "listCollections" | "listAllRequests"
>;

interface RunOutputContext extends RevealContext {
	client: RunOutputClient;
}

/** The secret-flagged values of one `variables` bag: `secret === true` and a non-empty string. */
function secretValuesOf(row: unknown): string[] {
	if (!isRecord(row) || !isRecord(row.variables)) return [];
	return Object.values(row.variables).flatMap((def) =>
		isRecord(def) && def.secret === true && typeof def.value === "string" && def.value !== ""
			? [def.value]
			: []
	);
}

function rowsOf(answer: unknown): unknown[] {
	return Array.isArray(answer) ? answer : [answer];
}

/** The workspace reads a run-output rule is built from, each by the name a failure reports. */
const SCOPE_LOOKUPS = {
	globals: (client: RunOutputClient, signal?: AbortSignal) => client.getGlobals(signal),
	environments: (client: RunOutputClient, signal?: AbortSignal) =>
		client.listEnvironments(signal),
	collections: (client: RunOutputClient, signal?: AbortSignal) => client.listCollections(signal),
	requests: (client: RunOutputClient, signal?: AbortSignal) => client.listAllRequests(signal),
};

type ScopeName = keyof typeof SCOPE_LOOKUPS;

/**
 * A run-output projection that could not be built because a workspace read
 * failed. Masking with the reads that answered would hand an agent every
 * secret the failed one holds, so the read it guards answers this instead:
 * a tool as an error result, a resource or a prompt as a failed request.
 */
export class MaskingIncompleteError extends Error {
	constructor(failed: readonly ScopeName[], reason: unknown) {
		const detail = reason instanceof Error ? reason.message : String(reason);
		super(
			`Nothing is returned: masking this result's secrets could not complete, because the ${failed.join(", ")} lookup${failed.length === 1 ? "" : "s"} it reads the secret values from failed (${detail}). ` +
				`With ${REVEAL_SETTING} off, a result that could carry a secret is withheld whole rather than returned partly masked. ` +
				`Retry once the engine answers; a call that sent a request has already sent it, so check list_runs before sending it again.`
		);
		this.name = "MaskingIncompleteError";
	}
}

/** Every scope's rows, or {@link MaskingIncompleteError} naming each read that failed. */
async function readScopes(
	client: RunOutputClient,
	signal?: AbortSignal
): Promise<Record<ScopeName, unknown[]>> {
	const names = Object.keys(SCOPE_LOOKUPS) as ScopeName[];
	// `async` so a read that throws before it returns a promise is a rejection too.
	const settled = await Promise.allSettled(
		names.map(async (name) => SCOPE_LOOKUPS[name](client, signal))
	);
	const rejected = settled.flatMap((result) => (result.status === "rejected" ? [result] : []));
	if (rejected.length > 0) {
		const failed = names.filter((_, at) => settled[at].status === "rejected");
		throw new MaskingIncompleteError(failed, rejected[0].reason);
	}
	const rows = settled.map((result) => rowsOf((result as PromiseFulfilledResult<unknown>).value));
	return Object.fromEntries(names.map((name, at) => [name, rows[at]])) as Record<
		ScopeName,
		unknown[]
	>;
}

/**
 * The run-output projection for @p ctx: the identity when the user chose to
 * reveal secrets to agents, with no engine call made; otherwise
 * {@link withholdRunOutput} under the rule read from the workspace now.
 *
 * The values are every secret variable the workspace holds - globals, every
 * environment, every collection - and every literal credential a collection's
 * or a request's stored auth holds, which the engine writes into a header or
 * the query on the way out; the API-key header names are every stored block's
 * plus @p auth (a block the caller sent inline). That is a superset of the
 * scopes the engine masks a snapshot against (globals, the run's environment,
 * its collection chain), and it is what a read can know: a run row names its
 * environment but not the chain an inline send resolved through, a list reads
 * many runs at once and an inbox capture belongs to no run at all. A secret is
 * a secret whichever scope a run read it from.
 *
 * Every read must answer: one that fails throws {@link MaskingIncompleteError}
 * rather than masking with what the others read. The values are read now, not
 * as the run read them: a secret changed since masks under its new value only.
 */
export async function runOutputShape(
	ctx: RunOutputContext,
	signal?: AbortSignal,
	auth: readonly unknown[] = []
): Promise<Projection> {
	if (ctx.config.revealSecretsToAgents) return (value) => value;
	const { globals, environments, collections, requests } = await readScopes(ctx.client, signal);
	const ownerAuth = [...collections, ...requests].map((row) =>
		isRecord(row) ? row.auth : undefined
	);
	const rule: RunOutputRule = {
		forms: secretForms([
			...[...globals, ...environments, ...collections].flatMap(secretValuesOf),
			...ownerAuth.flatMap(authCredentialValues),
		]),
		apiKeyHeaders: [...ownerAuth, ...auth].flatMap((block) => apiKeyHeaderName(block) || []),
	};
	return (value) => withholdRunOutput(value, rule);
}

/**
 * A request about to be sent - `start_load_run`'s planned run, composed with
 * everything resolved - as an agent may read it, which is as the run will
 * record it: its `auth` block withheld as a stored row's is, so a literal
 * token reads as `<member>Withheld`, then every string under
 * {@link runOutputShape}'s rule. @p request itself with reveal on, with no
 * engine call made.
 */
export async function withholdPlannedRequest(
	ctx: RunOutputContext,
	request: Record<string, unknown>,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	if (ctx.config.revealSecretsToAgents) return request;
	const mask = await runOutputShape(ctx, signal, [request.auth]);
	const authWithheld = "auth" in request ? { auth: withholdAuth(request.auth) } : {};
	return mask({ ...request, ...authWithheld }) as Record<string, unknown>;
}
