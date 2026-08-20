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
 * What stays here is the reduction itself, for the one renderer reader that
 * still needs it and has not moved yet: the spec diff (`spec-diff.ts`, which
 * compares two *documents* rather than a document to a collection), which is
 * phase B's remaining move. The URL *split* went with the export (issue #855):
 * the skeleton was its last reader here, and the engine's
 * `split_request_url` is now the only one.
 *
 * Until the diff goes, one rule has two implementations, which is exactly the
 * thing this codebase distrusts - so
 * `engine/tests/fixtures/operation-shape-conformance.json` is the table both
 * read, and `operation-shape.conformance.test.ts` is this side of it.
 *
 * The reduction: the origin dropped, the query and fragment dropped, and every
 * template placeholder - `{{petId}}`, `{petId}` - flattened to a single `{}`.
 * Flattening the name too is deliberate: a spec that renames its path parameter
 * describes the same endpoint, and a comparison that turned on the parameter's
 * spelling would report a rename as "removed and added".
 */

import { VARIABLE_PATTERN } from "@/constants/variables";

/**
 * An OpenAPI path parameter, `{petId}`.
 *
 * Vayu's own `{{name}}` tokens are flattened first, by the app's single
 * `VARIABLE_PATTERN` (see `constants/variables.ts` - a second copy of that
 * matcher is what `variable-pattern-single-source.test.ts` exists to refuse).
 * What is left for this one is the single-brace syntax only OpenAPI writes.
 */
const SPEC_PLACEHOLDER = /\{[^{}]*\}/g;

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
