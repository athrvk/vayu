/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Matching a collection's existing requests to a spec's operations, by method
 * and path template (issue #638).
 *
 * This is what "bind an existing collection to a spec" needs and an import does
 * not: an import *creates* the requests, so it stamps each one's identity as it
 * builds it. Binding after the fact has two independent lists and has to work
 * out which request is which operation - by structure, because that is the only
 * thing the two sides share. A request's URL carries `{{baseUrl}}` and Vayu's
 * `{{petId}}` variables; the document writes `/pets/{petId}` and folds the
 * server into `servers[]`.
 *
 * So both sides are reduced to a **path shape**: the origin dropped, the query
 * and fragment dropped, and every template placeholder - `{{petId}}`, `{petId}`
 * - flattened to a single `{}`. Flattening the name too is deliberate: a spec
 * that renames its path parameter describes the same endpoint, and a match that
 * turned on the parameter's spelling would report a rename as "removed and
 * added". Two operations that differ only in a parameter name are the same
 * position on the server and cannot both exist.
 *
 * A second pass then offers each remaining request to the templates it could be
 * an instance of, because a hand-built collection writes the id in
 * (`/pets/42`), and a matcher that only compared shapes would find nothing
 * outside collections that were already imported from a spec.
 *
 * Ambiguity is refused rather than guessed at, in both passes: when two requests
 * reduce to the same shape, or one request could be two operations, neither is
 * matched and the count says so. A wrong identity is worse than none - #627's
 * sync applies changes *by* it.
 */

import type { Request, SpecOperation } from "@/types";
import { VARIABLE_PATTERN, isVariableToken } from "@/constants/variables";

/**
 * An OpenAPI path parameter, `{petId}`.
 *
 * Vayu's own `{{name}}` tokens are flattened first, by the app's single
 * `VARIABLE_PATTERN` (see `constants/variables.ts` - a second copy of that
 * matcher is what `variable-pattern-single-source.test.ts` exists to refuse).
 * What is left for this one is the single-brace syntax only OpenAPI writes.
 */
const SPEC_PLACEHOLDER = /\{[^{}]*\}/g;

/** `scheme://host[:port]`, the other way a request states where it goes. */
const ORIGIN = /^[a-zA-Z][\w+.-]*:\/\/[^/?#]*/;

/**
 * The path portion of a request URL, or `undefined` when there is nothing that
 * can be compared to a spec path.
 *
 * `undefined` and not `"/"`: a request whose URL is only a variable
 * (`{{baseUrl}}`) states no path, and defaulting it to the root would match it
 * against the spec's root operation - a match nobody asked for.
 */
export function requestPathShape(url: string): string | undefined {
	let rest = url.trim();
	if (!rest) return undefined;

	// Query and fragment first: an origin regex must not have to skip them, and
	// a `?` inside a path is not a thing.
	rest = rest.split("#")[0].split("?")[0];

	// A leading `{{baseUrl}}` - what every OpenAPI import writes - stands in for
	// the whole origin, so the segment before the first slash is dropped when it
	// is exactly one variable token. `isVariableToken` rather than a regex of our
	// own, for the same single-matcher reason as above.
	const firstSlash = rest.indexOf("/");
	const head = firstSlash === -1 ? rest : rest.slice(0, firstSlash);
	if (isVariableToken(head)) {
		rest = rest.slice(head.length);
	} else if (ORIGIN.test(rest)) {
		rest = rest.replace(ORIGIN, "");
	} else if (!rest.startsWith("/")) {
		// A schemeless URL (`api.example.com/pets`): the first segment is a host
		// when it looks like one, and a path when it does not.
		if (head.includes(".") || head.includes(":")) {
			rest = firstSlash === -1 ? "" : rest.slice(firstSlash);
		}
	}

	if (!rest) return undefined;
	if (!rest.startsWith("/")) rest = `/${rest}`;
	return normalizePathShape(rest);
}

/**
 * A spec path (`/pets/{petId}`) reduced to the same shape a request URL reduces
 * to, so the two are comparable.
 */
export function specPathShape(path: string): string {
	return normalizePathShape(path);
}

function normalizePathShape(path: string): string {
	const flattened = path.replace(VARIABLE_PATTERN, "{}").replace(SPEC_PLACEHOLDER, "{}");
	// A trailing slash is not a different endpoint, and importers disagree about
	// whether to keep one. The root stays `/`.
	return flattened.length > 1 ? flattened.replace(/\/+$/, "") : flattened;
}

/** `GET /pets/{}` - the key both sides are bucketed by. */
export function operationShapeKey(method: string, pathShape: string): string {
	return `${method.toUpperCase()} ${pathShape}`;
}

/** One request paired with the operation it turned out to be. */
export interface OperationMatch {
	request: Request;
	operation: SpecOperation;
}

export interface MatchResult {
	/** Requests that resolved to exactly one operation, and it to exactly one of them. */
	matched: OperationMatch[];
	/** Requests left over - no operation, or an ambiguous shape. */
	unmatchedRequests: Request[];
	/** Operations no request claimed. These become new requests in sync (#627), not here. */
	unmatchedOperations: SpecOperation[];
}

/**
 * Pair a collection's requests with a spec's operations, one to one.
 *
 * Neither side is mutated and nothing is written: the caller decides what to do
 * with the result, and shows the counts before it does.
 */
export function matchOperations(
	requests: readonly Request[],
	operations: readonly SpecOperation[]
): MatchResult {
	const requestsByKey = bucket(requests, (r) => {
		const shape = requestPathShape(r.url);
		return shape === undefined ? undefined : operationShapeKey(r.method, shape);
	});
	const operationsByKey = bucket(operations, (o) =>
		operationShapeKey(o.method, specPathShape(o.path))
	);

	const matched: OperationMatch[] = [];
	const claimedRequests = new Set<Request>();
	const claimedOperations = new Set<SpecOperation>();

	for (const [key, candidates] of requestsByKey) {
		const operationCandidates = operationsByKey.get(key);
		// Exactly one on each side, or neither is claimed - see the ambiguity rule
		// in the module header.
		if (candidates.length !== 1 || operationCandidates?.length !== 1) continue;
		matched.push({ request: candidates[0], operation: operationCandidates[0] });
		claimedRequests.add(candidates[0]);
		claimedOperations.add(operationCandidates[0]);
	}

	/*
	 * Second pass, for the requests a hand-built collection is full of: a URL
	 * with the id filled in (`/pets/42`) is the same operation as `/pets/{petId}`,
	 * and refusing to see that would leave bind-from-here matching almost nothing
	 * outside a collection that was itself imported from a spec.
	 *
	 * It runs only over what pass one did not claim, so a literal path in the
	 * document always wins over a placeholder it could also have filled - which is
	 * the precedence OpenAPI itself gives (`/pets/mine` before `/pets/{petId}`).
	 * The uniqueness rule is unchanged and applies in both directions: a request
	 * with two candidate operations, or an operation two requests could fill, is
	 * left alone.
	 */
	const openRequests = requests.filter((r) => !claimedRequests.has(r));
	const openOperations = operations.filter((o) => !claimedOperations.has(o));
	const candidatesFor = new Map<Request, SpecOperation[]>();
	const claimantsOf = new Map<SpecOperation, Request[]>();
	for (const request of openRequests) {
		const shape = requestPathShape(request.url);
		if (shape === undefined) continue;
		for (const operation of openOperations) {
			if (operation.method.toUpperCase() !== request.method.toUpperCase()) continue;
			if (!fillsTemplate(shape, specPathShape(operation.path))) continue;
			push(candidatesFor, request, operation);
			push(claimantsOf, operation, request);
		}
	}
	for (const [request, candidates] of candidatesFor) {
		if (candidates.length !== 1) continue;
		const operation = candidates[0];
		if (claimantsOf.get(operation)?.length !== 1) continue;
		matched.push({ request, operation });
		claimedRequests.add(request);
		claimedOperations.add(operation);
	}

	return {
		matched,
		unmatchedRequests: requests.filter((r) => !claimedRequests.has(r)),
		unmatchedOperations: operations.filter((o) => !claimedOperations.has(o)),
	};
}

/**
 * Whether a concrete path could be this template with its placeholders filled:
 * the same number of segments, and every non-placeholder segment equal.
 *
 * A placeholder matches one segment and never a `/`, which is what the OpenAPI
 * path-templating rules say - so `/pets/42/toys` is not `/pets/{petId}`.
 */
function fillsTemplate(pathShape: string, templateShape: string): boolean {
	const path = pathShape.split("/");
	const template = templateShape.split("/");
	if (path.length !== template.length) return false;
	return template.every((segment, i) => segment === "{}" || segment === path[i]);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const existing = map.get(key);
	if (existing) existing.push(value);
	else map.set(key, [value]);
}

function bucket<T>(items: readonly T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		if (key === undefined) continue;
		const existing = map.get(key);
		if (existing) existing.push(item);
		else map.set(key, [item]);
	}
	return map;
}
