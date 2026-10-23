/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The URL a request sends, as the Params panel's "Sends" line and the request
 * tab's title both read it (#2637).
 *
 * Path rows are substituted first, each value resolved then encoded as compose
 * does (#1764) - or raw under `disableUrlEncoding` (#1765) - and only then is
 * the URL's own `{{}}` pass run, a value landing in the path, query or fragment
 * encoded by that part's rule and the literal text around it made sendable
 * (#1773, #2465). Two surfaces that resolved this separately disagreed about
 * `a b`: one drew `%20` and the other a space.
 *
 * A name `POST /compose` reports in `deferredVariables` (#2521) is left written
 * as `{{name}}`: a pre-request script runs before the send and may change what
 * it answers, so the stored value is not what will be sent (#2741). Which names
 * those are is the engine's answer, passed in; nothing here decides whether a
 * script runs.
 *
 * Pure: it takes the resolver rather than reading a hook, so a caller that
 * holds a bound data row passes a resolver closed over it.
 */

import {
	VARIABLE_PATTERN,
	VARIABLE_SPLIT_PATTERN,
	containsVariableToken,
} from "@/constants/variables";
import type { KeyValueEntry, Request } from "@/types";
import { answeringPathRows, composePathParams, substitutePathVariables } from "./path-variables";
import { resolveUrlTemplate } from "./query-encoding";

/** The members of a request the sent URL is a function of. */
export type SendsUrlInput = Pick<Request, "url" | "params" | "disableUrlEncoding">;

type Resolve = (input: string) => string;

interface SendsInput {
	url: string;
	rows: KeyValueEntry[];
	encode: boolean;
	deferred: readonly string[];
}

function sendsInput(request: SendsUrlInput, deferred: readonly string[]): SendsInput {
	return {
		url: request.url,
		rows: composePathParams(request.params),
		encode: !request.disableUrlEncoding,
		deferred,
	};
}

/** The name inside a `{{name}}` token, trimmed the way the resolvers read it. */
function tokenName(token: string): string {
	return token.slice(2, -2).trim();
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

function resolveSends({ url, rows, encode, deferred }: SendsInput, resolveAll: Resolve): string {
	const resolve = leaveDeferred(resolveAll, deferred);
	return resolveUrlTemplate(substitutePathVariables(url, rows, resolve, { encode }), resolve, {
		encode,
	});
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
 * The text the sent URL is built from that can hold a `{{token}}`: the URL and
 * the values of the path rows the line substitutes, no others.
 */
function sendsTemplates(request: SendsUrlInput): string[] {
	const pathValues = answeringPathRows(request.url, composePathParams(request.params)).flatMap(
		(row) => (typeof row.value === "string" ? [row.value] : [])
	);
	return [request.url, ...pathValues];
}

/**
 * Whether the sent URL has a `{{token}}` anywhere: the gate for asking the
 * engine whether a script defers it. A literal URL has nothing to defer.
 */
export function sendsHasTokens(request: SendsUrlInput): boolean {
	return sendsTemplates(request).some((text) => containsVariableToken(text));
}

/**
 * The names in @p deferred that the sent URL actually uses, in order of first
 * appearance. The engine lists every name a scope answers for the whole
 * request, not the ones this line holds.
 */
export function deferredNamesInSends(
	request: SendsUrlInput,
	deferred: readonly string[]
): string[] {
	if (deferred.length === 0) return [];
	const answered = new Set(deferred);
	const used = new Set<string>();
	for (const text of sendsTemplates(request)) {
		for (const [token] of text.matchAll(VARIABLE_PATTERN)) {
			const name = tokenName(token);
			if (answered.has(name)) used.add(name);
		}
	}
	return [...used];
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
