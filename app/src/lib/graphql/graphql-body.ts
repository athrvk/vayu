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
 *
 * **"Not yet valid JSON" and "holds a `{{variable}}`" are different things, and
 * conflating them dropped a working idiom.** `{"limit": {{n}}}` is not JSON at
 * rest and is JSON on the wire, because the engine resolves templates in the
 * body before sending; dropping it meant the request went out with no variables
 * at all and nothing said so. So the serializer masks out-of-string tokens,
 * checks *that* parses, and writes the token back into the envelope verbatim -
 * the body at rest is a template, exactly as it is for every other body mode.
 * Genuinely broken text is still dropped (that decision is PR #399's and stands);
 * what changed is that the pane now says which of the two you have -
 * `classifyVariables` is what it reads.
 *
 * **The engine envelopes too, and that is deliberate - not a duplicate.** This
 * file exists because the *editor* is two panes and the wire is one object; the
 * engine's `graphql_wire_body` (`engine/src/http/graphql_body.cpp`) exists
 * because a `graphql` body can also arrive from MCP or a raw `POST /execute`
 * as a bare document, and those clients have no editor to split. Issue #417 is
 * what happens when only this half exists: the renderer sent valid GraphQL and
 * every other client sent a bare query under the wrong Content-Type. The engine
 * is the backstop under all of them, and what this file produces passes through
 * it byte-identical - it is already an envelope, which is the one shape the
 * engine leaves alone.
 */

import { Kind, parse as parseGraphQLDocument } from "graphql";
import { hasJsonTemplateSentinel, maskJsonTemplates, unmaskJsonTemplates } from "./templates";

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

/**
 * What the Variables pane's text is, from the wire's point of view.
 *
 * The pane's reader is a badge: `templated` and `invalid` look identical in the
 * editor (both are red to Monaco's JSON worker) and could not be more different
 * on the wire - one is sent after resolution, the other is not sent at all.
 */
export type VariablesForm = "empty" | "json" | "templated" | "invalid";

export function classifyVariables(text: string): VariablesForm {
	const trimmed = text.trim();
	if (!trimmed) return "empty";
	if (parseJson(trimmed) !== undefined) return "json";
	return parseTemplatedJson(trimmed) ? "templated" : "invalid";
}

/** `JSON.parse`, or `undefined` when the text is not JSON. Never throws. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * The text read as JSON with its out-of-string `{{tokens}}` masked, or null when
 * it is broken for some other reason (or holds no token at all, in which case
 * the plain parse above already answered).
 */
function parseTemplatedJson(text: string): { value: unknown; tokens: string[] } | null {
	const { masked, tokens } = maskJsonTemplates(text);
	if (tokens.length === 0) return null;
	const value = parseJson(masked);
	return value === undefined ? null : { value, tokens };
}

export function parseGraphQLBody(body: string): GraphQLBodyParts {
	const parts = readEnvelope(body, JSON.parse.bind(JSON)) ?? readTemplatedEnvelope(body);
	return parts ?? EMPTY_PARTS(body);
}

/** The envelope shape, or null when `body` is not one. */
function readEnvelope(body: string, read: (text: string) => unknown): GraphQLBodyParts | null {
	let parsed: unknown;
	try {
		parsed = read(body);
	} catch {
		// Body is not JSON - treat as a raw query string (e.g. Insomnia import)
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const { query, variables, operationName, ...extras } = parsed as Record<string, unknown>;
	if (typeof query !== "string") return null;
	return {
		query,
		variables: variablesText(variables),
		operationName: typeof operationName === "string" ? operationName : "",
		extras,
	};
}

/**
 * The pane text for an envelope's `variables` value.
 *
 * A string-typed `variables` is shown verbatim rather than JSON-encoded: the
 * Postman importer deliberately preserves that shape, and pretty-printing it
 * rendered `{"id":1}` as the quoted, backslash-escaped blob `"{\"id\":1}"` -
 * lossless and unreadable, and un-editable without deleting the escapes by
 * hand. Editing it back to an object is what converts the envelope; until then
 * it round-trips as it arrived.
 */
function variablesText(variables: unknown): string {
	if (typeof variables === "string") return variables;
	return variables ? JSON.stringify(variables, null, 2) : "";
}

/**
 * An envelope whose `variables` hold `{{tokens}}` - not JSON at rest, JSON once
 * the engine resolves it.
 *
 * Only the `variables` value may carry them. A token anywhere else (inside
 * `extensions`, say) would survive parsing as a placeholder string and be
 * written back as that placeholder, so such a body is refused here and falls
 * through to the raw-query fallback - which is exactly what it does on master
 * today, since it is not JSON either.
 */
function readTemplatedEnvelope(body: string): GraphQLBodyParts | null {
	const templated = parseTemplatedJson(body);
	if (!templated) return null;
	const parts = readEnvelope(body, () => templated.value);
	if (!parts) return null;
	const carrier = JSON.stringify({ ...parts.extras, query: parts.query, o: parts.operationName });
	if (hasJsonTemplateSentinel(carrier)) return null;
	return { ...parts, variables: unmaskJsonTemplates(parts.variables, templated.tokens) };
}

export function serializeGraphQLBody(parts: GraphQLBodyParts): string {
	const { query, variables, operationName, extras } = parts;
	const trimmed = variables.trim();
	const plain = trimmed ? parseJson(trimmed) : undefined;
	// Variables panel has in-progress invalid JSON - preserve everything else.
	const templated = plain === undefined && trimmed ? parseTemplatedJson(trimmed) : null;
	const vars = plain !== undefined ? plain : templated?.value;
	// Extras first so a key we *do* model always wins over a stale copy of it -
	// `extras` is built by destructuring the three out, so this cannot happen
	// today, and relying on that ordering rather than restating it is how it
	// would stop being true.
	const json = JSON.stringify({
		...extras,
		query,
		...(operationName ? { operationName } : {}),
		...(vars !== undefined && { variables: vars }),
	});
	return templated ? unmaskJsonTemplates(json, templated.tokens) : json;
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
/** One operation in the document, as an outline row would show it. */
export interface DocumentOperation {
	kind: "query" | "mutation" | "subscription";
	/** The operation's name, or null for the anonymous (shorthand) form. */
	name: string | null;
	/**
	 * The 1-based line the operation starts on, which is what a code editor
	 * reveals by. Read by `findOperationLine` below, so that an outline row
	 * rendered from one copy of the document can scroll a second copy of it.
	 */
	line: number;
}

/**
 * Every operation the document defines, in source order, named or not.
 *
 * Separate from `operationNames`, which answers a narrower question - "which
 * names may be sent as `operationName`" - and therefore drops both the kind and
 * the anonymous operation. An outline that dropped the anonymous one would show
 * nothing at all for the most common single-query document.
 */
export function documentOutline(query: string): DocumentOperation[] {
	if (!query.trim()) return [];
	try {
		return parseGraphQLDocument(query)
			.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)
			.map((d) =>
				d.kind === Kind.OPERATION_DEFINITION
					? {
							kind: d.operation,
							name: d.name?.value ?? null,
							// `parse` carries locations unless asked not to; the fallback
							// is the first line, which is where a document with a single
							// operation starts anyway.
							line: d.loc?.startToken.line ?? 1,
						}
					: { kind: "query" as const, name: null, line: 1 }
			);
	} catch {
		return [];
	}
}

/** Which operation an outline row stands for, in terms that outlive a re-parse. */
export interface OperationRef {
	/** The operation's name, or null for the anonymous (shorthand) form. */
	name: string | null;
	/** Its position among the document's operations, in source order. */
	index: number;
}

/**
 * The line `ref` sits on in `query`, or null when this document no longer has
 * that operation.
 *
 * The two copies are not the same text: an outline drawn from the *stored*
 * request scrolls the editor's *live* buffer, which is a keystroke or two ahead
 * of it. So the row is resolved by name against the buffer rather than carrying
 * a line across - a line taken from the stored copy points at whatever the live
 * one happens to have there.
 *
 * The index is the anonymous document's answer, since `{ … }` has no name to
 * match on; it is only trusted when the operation it lands on is anonymous too,
 * so a rename does not silently reveal the operation that took its place.
 */
export function findOperationLine(query: string, ref: OperationRef): number | null {
	const operations = documentOutline(query);
	if (ref.name !== null) {
		return operations.find((o) => o.name === ref.name)?.line ?? null;
	}
	const positional = operations[ref.index];
	return positional && positional.name === null ? positional.line : null;
}

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
