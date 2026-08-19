/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The path shape a request URL and an OpenAPI path both reduce to (issue #638).
 *
 * **The matcher this file was named for now lives in the engine** (issue #761):
 * `engine/include/vayu/core/operation_match.hpp` pairs a collection's requests
 * with a document's operations, and `POST /specs/match` is how the Spec tab
 * asks. It moved so that binding an existing collection is reachable from
 * anything that is not the renderer - an agent over MCP first among them -
 * rather than through a second copy of a rule that decides which request is
 * which operation.
 *
 * What stays here is the reduction itself, for the two renderer readers that
 * still need it and have not moved yet: the spec diff (`spec-diff.ts`, which
 * compares two *documents* rather than a document to a collection) and the
 * export skeleton (`exporters/skeleton.ts`, which needs a URL split into the
 * origin that becomes a `servers[]` entry and the path that becomes a `paths`
 * key). Both are phase B's remaining moves.
 *
 * Until they go, one rule has two implementations, which is exactly the thing
 * this codebase distrusts - so
 * `engine/tests/fixtures/operation-shape-conformance.json` is the table both
 * read, and `operation-shape.conformance.test.ts` is this side of it.
 *
 * The reduction: the origin dropped, the query and fragment dropped, and every
 * template placeholder - `{{petId}}`, `{petId}` - flattened to a single `{}`.
 * Flattening the name too is deliberate: a spec that renames its path parameter
 * describes the same endpoint, and a comparison that turned on the parameter's
 * spelling would report a rename as "removed and added".
 */

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
 * A request URL split into the part that says *where* it goes and the part that
 * says *what* it addresses.
 *
 * Export (#630) keeps both halves - the origin becomes a `servers[]` entry and
 * the path becomes a `paths` key. The engine's matcher splits a URL the same
 * way to flatten the path (`split_request_url`), which is what the shape
 * conformance fixture pins: a second opinion about what counts as an origin
 * would put a request under a `servers[]` entry the document it was matched
 * against does not have.
 */
export interface RequestUrlParts {
	/**
	 * The `{{baseUrl}}` token, or the `scheme://host[:port]`, the URL starts
	 * with - absent when it states neither.
	 */
	origin?: string;
	/**
	 * The path, with its template placeholders exactly as the URL wrote them
	 * (`/pets/{{petId}}`), or `undefined` when the URL states no path at all.
	 */
	path?: string;
}

export function splitRequestUrl(url: string): RequestUrlParts {
	let rest = url.trim();
	if (!rest) return {};
	let origin: string | undefined;

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
		origin = head;
		rest = rest.slice(head.length);
	} else if (ORIGIN.test(rest)) {
		origin = ORIGIN.exec(rest)?.[0];
		rest = rest.replace(ORIGIN, "");
	} else if (!rest.startsWith("/")) {
		// A schemeless URL (`api.example.com/pets`): the first segment is a host
		// when it looks like one, and a path when it does not.
		if (head.includes(".") || head.includes(":")) {
			origin = head;
			rest = firstSlash === -1 ? "" : rest.slice(firstSlash);
		}
	}

	if (!rest) return { ...(origin ? { origin } : {}) };
	if (!rest.startsWith("/")) rest = `/${rest}`;
	return { ...(origin ? { origin } : {}), path: rest };
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
