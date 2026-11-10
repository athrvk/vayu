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
 * Then what only the wire adds or drops (#3425): an API key placed in the query
 * is appended, as the engine's `append_query_param` does, and the fragment is
 * cut, because libcurl never sends it. The key is the request's *effective*
 * auth - `inherit` already walked by the caller - and the tab title leaves it
 * out, so a title never carries a credential. The cut applies to both: a
 * fragment is never part of what is sent. Only an API key is appended; an OAuth
 * 2.0 token placed in the query, and a GraphQL GET's query, are not shown.
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
	 * Only an API key placed in the query changes the URL. Omitted by the tab
	 * title, which must stay free of credentials.
	 */
	auth?: Record<string, unknown>;
};

type Resolve = (input: string) => string;

/** An API key's two halves as written, before `{{token}}`s are resolved. */
interface QueryKey {
	key: string;
	value: string;
}

interface SendsInput {
	url: string;
	rows: KeyValueEntry[];
	encode: boolean;
	deferred: readonly string[];
	queryKey: QueryKey | null;
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

function sendsInput(request: SendsUrlInput, deferred: readonly string[]): SendsInput {
	return {
		url: request.url,
		rows: composePathParams(request.params),
		encode: !request.disableUrlEncoding,
		deferred,
		queryKey: queryKeyOf(request.auth),
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

function resolveSends(
	{ url, rows, encode, deferred, queryKey }: SendsInput,
	resolveAll: Resolve
): string {
	const resolve = leaveDeferred(resolveAll, deferred);
	const resolved = resolveUrlTemplate(
		substitutePathVariables(url, rows, resolve, { encode }),
		resolve,
		{ encode }
	);
	const { base } = splitFragment(resolved);
	// No URL, no line: an appended `?k=v` would hide that the request has none.
	if (queryKey === null || base.trim() === "") return base;
	return appendQueryParam(base, resolve(queryKey.key), resolve(queryKey.value), encode);
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
	return resolveSends(sendsInput(request, deferred), resolve);
}

/**
 * The text the sent URL is built from that can hold a `{{token}}`: the URL, the
 * values of the path rows the line substitutes and an API key placed in the
 * query, no others.
 */
function sendsTemplates(request: SendsUrlInput): string[] {
	const pathValues = answeringPathRows(request.url, composePathParams(request.params)).flatMap(
		(row) => (typeof row.value === "string" ? [row.value] : [])
	);
	const queryKey = queryKeyOf(request.auth);
	return [request.url, ...pathValues, ...(queryKey ? [queryKey.key, queryKey.value] : [])];
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

const sendsResolvers = new WeakMap<Resolve, Resolve>();

/**
 * The cache's resolver for {@link sendsCacheInput} text. One wrapper per
 * `resolve`, so the cache's identity check on the resolver still means what it
 * says (`lib/dynamic-variable-cache.ts`).
 */
export function sendsResolver(resolve: Resolve): Resolve {
	let wrapped = sendsResolvers.get(resolve);
	if (!wrapped) {
		wrapped = (input) => resolveSends(JSON.parse(input) as SendsInput, resolve);
		sendsResolvers.set(resolve, wrapped);
	}
	return wrapped;
}
