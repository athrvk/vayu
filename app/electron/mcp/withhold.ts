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
 * `valueWithheld: true`, an auth member `<member>Withheld: true`, and a config
 * URL `credentialsWithheld: true`.
 *
 * Every read surface goes through here: the read tools, the `vayu://`
 * resources, and `update_engine_config`'s echo of the config table. What it
 * does not cover is said where it matters, in SECURITY.md: with write access
 * on, an agent can clear a variable's `secret` flag and read it back, and a
 * write tool's own answer echoes the stored row.
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
export const WITHHELD_AUTH_SENTENCE = `An auth credential (a token, password, client secret or key) comes back as \`<member>Withheld: true\` in place of its value unless the user has turned on ${REVEAL_SETTING}; a pure {{variable}} reference is shown as written. A block carrying such a marker is refused as \`auth\` by every tool that takes one, because it holds no credential.`;

/** What `get_cookies` says about cookie values. */
export const WITHHELD_COOKIE_SENTENCE = `Each cookie value comes back as \`valueWithheld: true\` unless the user has turned on ${REVEAL_SETTING}.`;

/** What `get_engine_config` says about proxy URLs. */
export const WITHHELD_CONFIG_SENTENCE = `A URL entry's credentials (\`proxyUrl\`'s user:password) are stripped, with \`credentialsWithheld: true\` on the entry, unless the user has turned on ${REVEAL_SETTING}.`;

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

/**
 * An auth block with its credentials withheld: the flat modes keep theirs at
 * the top level (`bearer.token`, `basic.password`, `apikey.value`), the rest
 * under `config` (OAuth 2.0's `clientSecret`, AWS's key pair, ...).
 */
function withholdAuth(auth: unknown): unknown {
	if (!isRecord(auth)) return auth;
	const outer = withholdCredentialMembers(auth);
	return isRecord(outer.config)
		? { ...outer, config: withholdCredentialMembers(outer.config) }
		: outer;
}

/**
 * The withheld markers in an auth block an agent passed back, top level and
 * `config`. A block read with its credentials withheld and written back would
 * store, or send, no credential in their place.
 */
export function withheldAuthMembers(auth: Record<string, unknown>): string[] {
	const markers = (block: Record<string, unknown>) =>
		[...CREDENTIAL_AUTH_MEMBERS]
			.map(withheldMarker)
			.filter((marker) => block[marker] !== undefined);
	return [...markers(auth), ...(isRecord(auth.config) ? markers(auth.config) : [])];
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

function withholdEntryCredentials(entry: unknown): unknown {
	if (!isRecord(entry) || typeof entry.key !== "string" || !URL_CONFIG_KEY.test(entry.key)) {
		return entry;
	}
	if (typeof entry.value !== "string" || !URL_USERINFO.test(entry.value)) return entry;
	return {
		...entry,
		value: entry.value.replace(URL_USERINFO, "$1"),
		credentialsWithheld: true,
	};
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
