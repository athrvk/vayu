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
 * Pure: it takes the resolver rather than reading a hook, so a caller that
 * holds a bound data row passes a resolver closed over it.
 */

import type { KeyValueEntry, Request } from "@/types";
import { composePathParams, substitutePathVariables } from "./path-variables";
import { resolveUrlTemplate } from "./query-encoding";

/** The members of a request the sent URL is a function of. */
export type SendsUrlInput = Pick<Request, "url" | "params" | "disableUrlEncoding">;

type Resolve = (input: string) => string;

interface SendsInput {
	url: string;
	rows: KeyValueEntry[];
	encode: boolean;
}

function sendsInput(request: SendsUrlInput): SendsInput {
	return {
		url: request.url,
		rows: composePathParams(request.params),
		encode: !request.disableUrlEncoding,
	};
}

function resolveSends({ url, rows, encode }: SendsInput, resolve: Resolve): string {
	return resolveUrlTemplate(substitutePathVariables(url, rows, resolve, { encode }), resolve, {
		encode,
	});
}

/** The sent URL resolved straight through `resolve`, with no cache in between. */
export function resolveSendsUrl(request: SendsUrlInput, resolve: Resolve): string {
	return resolveSends(sendsInput(request), resolve);
}

/**
 * The input to {@link sendsResolver}, as the one string a
 * `createStableResolve()` cache keys its validity on: a change to any member
 * the URL depends on re-resolves, anything else keeps the cached value.
 */
export function sendsCacheInput(request: SendsUrlInput): string {
	return JSON.stringify(sendsInput(request));
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
