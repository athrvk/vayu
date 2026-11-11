/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The URL a request sends, as the Params panel's "Sends" line and the request
 * tab's title both read it (#2637): the URL that reaches the server (#3425).
 *
 * Path rows are substituted first, each value resolved then encoded as compose
 * does (#1764) - or raw under `disableUrlEncoding` (#1765) - and only then is
 * the URL's own `{{}}` pass run, a value landing in the path, query or fragment
 * encoded by that part's rule and the literal text around it made sendable
 * (#1773, #2465). Two surfaces that resolved this separately disagreed about
 * `a b`: one drew `%20` and the other a space.
 *
 * Then what only the wire adds or drops (#3425, #3437), in the engine's order:
 * the auth's query parameter is appended, as `append_query_param` does, then a
 * GraphQL GET's document, and the fragment is cut last, because libcurl never
 * sends it. The auth is the request's *effective* one - `inherit` already walked
 * by the caller - and the title leaves it, the method and the body out, so a
 * title never carries a key, a token or a query. The cut applies to both: a
 * fragment is never part of what is sent.
 *
 * The auth parameter is an API key placed in the query, or an OAuth 2.0 token
 * placed there (`tokenPlacement: "query"`, in the config's `queryParamName`,
 * `access_token` when that is empty). The token is fetched at send, so the line
 * draws a fixed stand-in for it that the caller masks like any secret. The
 * GraphQL document is the body of a GET, which the engine sends as query
 * parameters and no body; its `{{}}` are resolved before it is encoded, as the
 * engine resolves them before it builds the query.
 *
 * The line a caller draws carries that value, so the resolution also answers
 * what it appended ({@link SendsResolved}): the caller masks that, and does not
 * resolve the key again, which would reroll a generator in it.
 *
 * A name `POST /compose` reports in `deferredVariables` (#2521) is left written
 * as `{{name}}`: a pre-request script runs before the send and may change what
 * it answers, so the stored value is not what will be sent (#2741). Which names
 * those are is the engine's answer, passed in; nothing here decides whether a
 * script runs.
 *
 * Pure: it takes the resolver rather than reading a hook, so a caller that
 * holds a bound data row passes a resolver closed over it.
 *
 * The same rule serves the field previews that resolve a whole field rather
 * than a URL - the key/value rows' sigma peek and the Body tab's Resolved pane
 * (`leaveDeferredField`, and `deferredNamesIn` in `lib/deferred-note`).
 */

import {
	VARIABLE_PATTERN,
	VARIABLE_SPLIT_PATTERN,
	containsVariableToken,
} from "@/constants/variables";
import type { BoundField, DataFieldContext } from "@/lib/data-bind-escaping";
import { deferredNamesIn, tokenName } from "@/lib/deferred-note";
import type { SnippetBody } from "@/services/codegen/types";
import { graphqlGetQuery, graphqlUrlContent, urlWithQuery } from "@/services/codegen/wire-body";
import type { KeyValueEntry, Request } from "@/types";
import { answeringPathRows, composePathParams, substitutePathVariables } from "./path-variables";
import {
	appendQueryParam,
	resolveUrlTemplate,
	splitFragment,
	trimCredential,
} from "./query-encoding";

/** The members of a request the sent URL is a function of. */
export type SendsUrlInput = Pick<Request, "url" | "params" | "disableUrlEncoding"> & {
	/**
	 * The effective auth, `resolveAuthForSend`'s record: `inherit` already walked.
	 * Only an API key or an OAuth 2.0 token placed in the query changes the URL.
	 * Omitted by the tab title, which never carries either.
	 */
	auth?: Record<string, unknown>;
	/** Read, with {@link body}, only for a GraphQL GET. Omitted by the tab title. */
	method?: string;
	body?: SnippetBody;
};

type Resolve = (input: string) => string;

/** What the sent URL resolves to, and the one secret a caller must hide in it. */
export interface SendsResolved {
	url: string;
	/**
	 * The API key's value as it was appended, resolved and trimmed, or the
	 * stand-in drawn for an OAuth 2.0 token, or null when nothing secret is on
	 * the line: no key appended, a blank value, or a `{{token}}` text that
	 * resolved to itself (an unset name, or one a script defers), which goes
	 * out as written and hides nothing. A key is a credential whether or not
	 * its variable is marked secret, so the caller masks this whatever the
	 * variable's flag says. One auth applies, so there is at most one.
	 */
	secret: string | null;
}

/** An API key's two halves as written, before `{{token}}`s are resolved. */
interface QueryKey {
	key: string;
	value: string;
}

/**
 * What the line draws for an OAuth 2.0 token, which is fetched at send and so
 * unknown here. Only unreserved characters, so no encoding touches it and the
 * masker finds it as written; long enough that no URL holds it by chance.
 */
const OAUTH2_TOKEN_STAND_IN = "vayu-oauth2-access-token-stand-in";

/** The query parameter name the engine writes when the config leaves it empty. */
const DEFAULT_OAUTH2_QUERY_PARAM = "access_token";

/**
 * Every member the sent URL depends on, so it is the cache's whole key: a field
 * read while resolving and left out of it would never re-resolve.
 */
interface SendsInput {
	url: string;
	rows: KeyValueEntry[];
	encode: boolean;
	deferred: readonly string[];
	queryKey: QueryKey | null;
	/** The OAuth 2.0 token's parameter name as written, or null off the query. */
	oauth2Param: string | null;
	/** A GraphQL GET's document as stored, or null for any other request. */
	graphql: string | null;
}

const stringField = (record: Record<string, unknown>, name: string): string => {
	const value = record[name];
	return typeof value === "string" ? value : "";
};

/**
 * The API key the engine appends to the query, or null: only mode `apikey` with
 * `in: "query"` and a key that is not blank (the engine writes nothing for one).
 */
function queryKeyOf(auth: SendsUrlInput["auth"]): QueryKey | null {
	if (!auth || auth.mode !== "apikey" || auth.in !== "query") return null;
	const key = stringField(auth, "key");
	if (trimCredential(key) === "") return null;
	return { key, value: stringField(auth, "value") };
}

/**
 * The name an OAuth 2.0 token placed in the query goes under, as written, or
 * null when the effective auth is not OAuth 2.0 or places it in the header. The
 * config is nested under `config`, as the engine reads it.
 */
function oauth2ParamOf(auth: SendsUrlInput["auth"]): string | null {
	if (!auth || auth.mode !== "oauth2") return null;
	const { config } = auth;
	if (typeof config !== "object" || config === null) return null;
	const settings = config as Record<string, unknown>;
	if (settings.tokenPlacement !== "query") return null;
	return stringField(settings, "queryParamName");
}

function sendsInput(request: SendsUrlInput, deferred: readonly string[]): SendsInput {
	return {
		url: request.url,
		rows: composePathParams(request.params),
		encode: !request.disableUrlEncoding,
		deferred,
		queryKey: queryKeyOf(request.auth),
		oauth2Param: oauth2ParamOf(request.auth),
		graphql: graphqlUrlContent(request.method ?? "", request.body) ?? null,
	};
}

/**
 * @p resolve, except that a `{{name}}` token naming one of @p deferred is
 * returned as written. It works on the text it is given, whether that is one
 * token (the encoded path) or the whole URL (`disableUrlEncoding`).
 */
function leaveDeferred(resolve: Resolve, deferred: readonly string[]): Resolve {
	if (deferred.length === 0) return resolve;
	const names = new Set(deferred);
	return (text) =>
		text
			.split(VARIABLE_SPLIT_PATTERN)
			.map((part, i) => {
				// The split keeps each token at an odd index; the even parts are
				// the literal text between, which has nothing to resolve.
				const isToken = i % 2 === 1;
				return isToken && !names.has(tokenName(part)) ? resolve(part) : part;
			})
			.join("");
}

type ResolveField = (input: string, context?: DataFieldContext) => BoundField;

/*
 * A deferred token is swapped for a stand-in, `{{NUL<index>}}`, that no resolver
 * answers while the field resolves, then swapped back. The field is resolved
 * whole because a picked data row escapes a cell by what surrounds the token
 * (inside a JSON string, in an XML attribute): resolving the pieces apart would
 * lose that scan state. NUL cannot be typed into a token name, so the stand-in
 * cannot collide with one.
 */
const NUL = "\u0000";

const fieldResolvers = new WeakMap<ResolveField, Map<string, ResolveField>>();

/**
 * @p resolve for a whole field, except that a `{{name}}` token naming one of
 * @p deferred is left as written. The rule is `leaveDeferred`'s, shaped for
 * `resolveField`: the context and the refusals pass through untouched.
 *
 * One wrapper per resolver and set of names, so a cache comparing resolvers by
 * identity (`stableRowField`, which keeps a `{{$randomInt}}` from rerolling) is
 * not defeated by the wrapping.
 */
export function leaveDeferredField(
	resolve: ResolveField,
	deferred: readonly string[]
): ResolveField {
	if (deferred.length === 0) return resolve;
	let byNames = fieldResolvers.get(resolve);
	if (!byNames) {
		byNames = new Map();
		fieldResolvers.set(resolve, byNames);
	}
	const key = deferred.join(NUL);
	let wrapped = byNames.get(key);
	if (!wrapped) {
		wrapped = fieldResolverLeaving(resolve, new Set(deferred));
		byNames.set(key, wrapped);
	}
	return wrapped;
}

function fieldResolverLeaving(resolve: ResolveField, names: ReadonlySet<string>): ResolveField {
	return (input, context) => {
		const held: string[] = [];
		const masked = input.replace(VARIABLE_PATTERN, (token) =>
			names.has(tokenName(token)) ? `{{${NUL}${held.push(token) - 1}}}` : token
		);
		if (held.length === 0) return resolve(input, context);
		const bound = resolve(masked, context);
		return {
			text: bound.text.replace(VARIABLE_PATTERN, (token, name: string) =>
				name.startsWith(NUL) ? (held[Number(name.slice(1))] ?? token) : token
			),
			refusals: bound.refusals,
		};
	};
}

/** @p sent unless it is blank or @p template's own `{{token}}` text, unresolved. */
function secretOf(template: string, sent: string): string | null {
	if (sent === "") return null;
	return sent === trimCredential(template) && containsVariableToken(sent) ? null : sent;
}

/** @p url with the API key appended, and the value it put there as a secret. */
function withApiKey(
	url: string,
	queryKey: QueryKey,
	resolve: Resolve,
	encode: boolean
): SendsResolved {
	const key = trimCredential(resolve(queryKey.key));
	const value = trimCredential(resolve(queryKey.value));
	return {
		url: appendQueryParam(url, key, value, encode),
		secret: key === "" ? null : secretOf(queryKey.value, value),
	};
}

/** @p url with the OAuth 2.0 token's stand-in appended, and the stand-in as the secret. */
function withOAuth2Token(
	url: string,
	param: string,
	resolve: Resolve,
	encode: boolean
): SendsResolved {
	const name = resolve(param) || DEFAULT_OAUTH2_QUERY_PARAM;
	return {
		url: appendQueryParam(url, name, OAUTH2_TOKEN_STAND_IN, encode),
		secret: OAUTH2_TOKEN_STAND_IN,
	};
}

/** @p url with the auth's query parameter, if the request places one there. */
function withAuthParameter(url: string, input: SendsInput, resolve: Resolve): SendsResolved {
	const { queryKey, oauth2Param, encode } = input;
	if (queryKey !== null) return withApiKey(url, queryKey, resolve, encode);
	if (oauth2Param !== null) return withOAuth2Token(url, oauth2Param, resolve, encode);
	return { url, secret: null };
}

/**
 * @p url with a GraphQL GET's document appended as the query parameters the
 * engine sends it as. The document is resolved first and encoded after: encoding
 * first would draw `%7B%7Bname%7D%7D` where the engine sends the value.
 */
function withGraphqlQuery(url: string, document: string | null, resolve: Resolve): string {
	if (document === null) return url;
	const query = graphqlGetQuery(resolve(document));
	return query === undefined ? url : urlWithQuery(url, query);
}

function resolveSends(input: SendsInput, resolveAll: Resolve): SendsResolved {
	const { url, rows, encode, deferred, graphql } = input;
	const resolve = leaveDeferred(resolveAll, deferred);
	const resolved = resolveUrlTemplate(
		substitutePathVariables(url, rows, resolve, { encode }),
		resolve,
		{ encode }
	);
	const { base } = splitFragment(resolved);
	// No URL, no line: an appended `?k=v` would hide that the request has none.
	if (base.trim() === "") return { url: base, secret: null };
	const authed = withAuthParameter(base, input, resolve);
	// The fragment is cut last: under `disableUrlEncoding` a `#` in the key or
	// value is written raw, and libcurl drops everything from it, the GraphQL
	// query included.
	const sent = splitFragment(withGraphqlQuery(authed.url, graphql, resolve)).base;
	return { url: sent, secret: authed.secret };
}

/**
 * The sent URL resolved straight through `resolve`, with no cache in between.
 * Each name in @p deferred stays written.
 */
export function resolveSendsUrl(
	request: SendsUrlInput,
	resolve: Resolve,
	deferred: readonly string[] = []
): string {
	return resolveSends(sendsInput(request, deferred), resolve).url;
}

/**
 * The text the sent URL is built from that can hold a `{{token}}`: the URL, the
 * values of the path rows the line substitutes, an API key placed in the query,
 * an OAuth 2.0 token's parameter name and a GraphQL GET's document, no others.
 */
function sendsTemplates(request: SendsUrlInput): string[] {
	const pathValues = answeringPathRows(request.url, composePathParams(request.params)).flatMap(
		(row) => (typeof row.value === "string" ? [row.value] : [])
	);
	const queryKey = queryKeyOf(request.auth);
	const oauth2Param = oauth2ParamOf(request.auth);
	const graphql = graphqlUrlContent(request.method ?? "", request.body);
	return [
		request.url,
		...pathValues,
		...(queryKey ? [queryKey.key, queryKey.value] : []),
		...(oauth2Param === null ? [] : [oauth2Param]),
		...(graphql === undefined ? [] : [graphql]),
	];
}

/**
 * Whether the sent URL has a `{{token}}` anywhere: the gate for asking the
 * engine whether a script defers it. A literal URL has nothing to defer.
 */
export function sendsHasTokens(request: SendsUrlInput): boolean {
	return sendsTemplates(request).some((text) => containsVariableToken(text));
}

/** The names in @p deferred that the sent URL actually uses. */
export function deferredNamesInSends(
	request: SendsUrlInput,
	deferred: readonly string[]
): string[] {
	return deferredNamesIn(deferred, sendsTemplates(request));
}

/**
 * The input to {@link sendsResolver}, as the one string a
 * `createStableResolve()` cache keys its validity on: a change to any member
 * the URL depends on re-resolves, anything else keeps the cached value.
 */
export function sendsCacheInput(request: SendsUrlInput, deferred: readonly string[] = []): string {
	return JSON.stringify(sendsInput(request, deferred));
}

const sendsResolvers = new WeakMap<Resolve, (input: string) => SendsResolved>();

/**
 * The cache's resolver for {@link sendsCacheInput} text. One wrapper per
 * `resolve`, so the cache's identity check on the resolver still means what it
 * says (`lib/dynamic-variable-cache.ts`). It answers the URL with the secret
 * the resolution appended, so the cache holds both from the one resolution.
 */
export function sendsResolver(resolve: Resolve): (input: string) => SendsResolved {
	let wrapped = sendsResolvers.get(resolve);
	if (!wrapped) {
		wrapped = (input) => resolveSends(JSON.parse(input) as SendsInput, resolve);
		sendsResolvers.set(resolve, wrapped);
	}
	return wrapped;
}
