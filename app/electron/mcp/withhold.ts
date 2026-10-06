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
 *        credentials in a proxy URL. Withheld unless the user turns on
 *        `revealSecretsToAgents`.
 *
 * Withheld is stated, never silent - the `projectOAuth2Token` precedent. An
 * agent that finds no value and is not told why concludes the data is empty or
 * broken, and acts on that. So a withheld variable or cookie carries
 * `valueWithheld: true`, an auth member `<member>Withheld: true`, a credential
 * row (a Postman attribute or parameter row) `valueWithheld: true` on the row,
 * and a config or proxy URL `credentialsWithheld: true`.
 *
 * What goes through here is what is *stored*: environments, globals,
 * collections and requests as the read tools and the `vayu://` resources answer
 * them, the cookie jars, and the config table (`update_engine_config`'s echo
 * included). What a run *recorded* does not: a request that references a
 * secret still sends it, so the trace of what was sent carries it, and
 * `rawRequest`, `get_run_report`, `get_run_samples`, `list_runs`,
 * `vayu://runs`, `vayu://run/*`, the run-report prompts, `get_inbox_captures`
 * and `list_request_examples` answer it as recorded. SECURITY.md says so, and
 * says what write access adds: an agent can clear a variable's `secret` flag
 * and read it back, and a write tool's own answer echoes the stored row.
 */

import type { McpSafetyConfig } from "./config.js";
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

/** The member an auth block carries in place of @p member once it is withheld. */
function withheldMarker(member: string): string {
	return `${member}Withheld`;
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

// --- Rows ---------------------------------------------------------------------

/**
 * One stored row - an environment, the globals, a collection, a saved request -
 * with its `variables` and `auth` withheld. Every other field passes through.
 */
export function withholdRowSecrets(row: unknown): unknown {
	if (!isRecord(row)) return row;
	return {
		...row,
		...("variables" in row ? { variables: withholdVariableBag(row.variables) } : {}),
		...("auth" in row ? { auth: withholdAuth(row.auth) } : {}),
	};
}

/** {@link withholdRowSecrets} over a list; a non-list answer passes through untouched. */
export function withholdRowListSecrets(list: unknown): unknown {
	return Array.isArray(list) ? list.map(withholdRowSecrets) : list;
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
