/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A GraphQL request body is one JSON object - the GraphQL-over-HTTP envelope -
 * but the editor shows it as two panes. These convert between the two.
 *
 * **The envelope is bigger than the panes, and that is the point.** It carries
 * `operationName` (which of several operations in the document to execute) and,
 * by spec, may carry `extensions` or anything a server has agreed with its
 * clients. None of those has a pane, and a converter that round-tripped only
 * `{query, variables}` *deleted* them on the first keystroke: the Postman
 * importer deliberately preserves `operationName`, and typing one character in
 * either pane silently dropped it, leaving a multi-operation document to
 * execute whichever operation the server picked. So parse keeps everything and
 * serialize writes everything back - `operationName` because a picker drives it,
 * the rest verbatim because they are not ours to discard.
 *
 * Both halves tolerate input the other would reject, deliberately:
 *
 * - `parseGraphQLBody` falls back to treating the whole body as a raw query
 *   string, because an Insomnia import produces exactly that.
 * - `serializeGraphQLBody` drops the variables when they are mid-edit and not
 *   yet valid JSON, rather than refusing to write - which would mean the query
 *   pane stopped saving while the variables pane had an unclosed brace.
 */

import { Kind, parse as parseGraphQLDocument } from "graphql";

/** The envelope, split into the parts the editor edits plus the parts it carries. */
export interface GraphQLBodyParts {
	query: string;
	/** The Variables pane text - the envelope's `variables`, pretty-printed. */
	variables: string;
	/** The operation to execute, or `""` when the envelope names none. */
	operationName: string;
	/**
	 * Every other envelope key, verbatim. Empty for a body Vayu wrote, non-empty
	 * for one an importer or a server-specific client produced (`extensions`).
	 * Held rather than understood: a key we do not model is still the user's.
	 */
	extras: Record<string, unknown>;
}

const EMPTY_PARTS = (query: string): GraphQLBodyParts => ({
	query,
	variables: "",
	operationName: "",
	extras: {},
});

export function parseGraphQLBody(body: string): GraphQLBodyParts {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const { query, variables, operationName, ...extras } = parsed as Record<
				string,
				unknown
			>;
			if (typeof query === "string") {
				return {
					query,
					variables: variables ? JSON.stringify(variables, null, 2) : "",
					operationName: typeof operationName === "string" ? operationName : "",
					extras,
				};
			}
		}
	} catch {
		// Body is not JSON - treat as a raw query string (e.g. Insomnia import)
	}
	// Raw query string - show as-is, no variables
	return EMPTY_PARTS(body);
}

export function serializeGraphQLBody(parts: GraphQLBodyParts): string {
	const { query, variables, operationName, extras } = parts;
	let vars: unknown;
	try {
		vars = variables.trim() ? JSON.parse(variables) : undefined;
	} catch {
		// Variables panel has in-progress invalid JSON - preserve everything else.
		vars = undefined;
	}
	// Extras first so a key we *do* model always wins over a stale copy of it -
	// `extras` is built by destructuring the three out, so this cannot happen
	// today, and relying on that ordering rather than restating it is how it
	// would stop being true.
	return JSON.stringify({
		...extras,
		query,
		...(operationName ? { operationName } : {}),
		...(vars !== undefined && { variables: vars }),
	});
}

/**
 * The names of the operations this document defines, in source order.
 *
 * Empty when the document does not parse (mid-edit is the normal case) and
 * empty for an anonymous operation, which has no name to send. A valid document
 * with more than one operation must name every one of them - the spec forbids
 * mixing anonymous with named - so "more than one name here" is exactly the
 * condition under which `operationName` has to be on the wire.
 */
export function operationNames(query: string): string[] {
	if (!query.trim()) return [];
	try {
		return parseGraphQLDocument(query)
			.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)
			.map((d) => (d.kind === Kind.OPERATION_DEFINITION ? (d.name?.value ?? "") : ""))
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * A GraphQL body for a document that arrived without an envelope.
 *
 * Insomnia's `application/graphql` body is the bare query text, and storing it
 * verbatim shipped it as the whole HTTP body - not JSON, so a GraphQL server
 * reads no query at all. The editor's raw-string fallback made it look healthy,
 * which is why this normalizes at import rather than at display.
 *
 * A body that already *is* an envelope is returned unchanged, so an import that
 * mislabels a JSON envelope as `application/graphql` is not double-wrapped.
 */
export function toGraphQLEnvelope(body: string): string {
	const trimmed = body.trim();
	if (!trimmed) return serializeGraphQLBody(EMPTY_PARTS(""));
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (
			parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			typeof (parsed as Record<string, unknown>).query === "string"
		) {
			return trimmed;
		}
	} catch {
		// Not JSON at all - the bare-document case this exists for.
	}
	return serializeGraphQLBody(EMPTY_PARTS(body));
}
