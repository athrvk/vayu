/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The body bytes the engine puts on the wire for the two modes whose stored
 * content is not what is sent: JSON-RPC completes a bare call into a frame, and
 * GraphQL wraps a bare document in a `{"query": ...}` envelope. A snippet built
 * from the stored content would send a request the server rejects where Vayu's
 * succeeds (#3198).
 *
 * Each function restates the engine's rule, `jsonrpc_wire_body`
 * (`engine/src/http/jsonrpc_body.cpp`) and `graphql_wire_body`
 * (`engine/src/http/graphql_body.cpp`), and is applied before masking, as the
 * engine applies it before the bytes leave. Content that is not a body to
 * complete (empty, unparseable, a batch array) comes back untouched.
 */

import { compactObject, readCompactJson } from "./compact-json";

/** `constants::request_body::MAX_JSON_DEPTH`: a JSON-RPC call nested deeper is left as typed. */
const ENGINE_MAX_JSON_DEPTH = 128;

/** The id a bare call is stamped with: constant, so a replay sends the bytes it replays. */
const DEFAULT_JSONRPC_ID = 1;

/** `std::isspace` in the C locale, which is what the engine's GraphQL probe uses. */
const OPENS_AS_JSON_OBJECT = /^[ \t\n\v\f\r]*\{[ \t\n\v\f\r]*"/;

/**
 * A bare JSON-RPC call completed as the engine writes it: `"jsonrpc":"2.0"` and
 * then, when no `id` member exists, `"id":1`, both after the members the author
 * wrote. The text is re-spelled compact, the way the engine's `dump ()` does it
 * (see `compact-json.ts` for why `JSON.parse` cannot be used). An object that
 * already has a string `jsonrpc` is a finished frame and is returned as typed,
 * as is anything that is not a single call object.
 */
export function jsonRpcWireBody(content: string): string {
	if (content === "") return content;
	// The text is unresolved: `[{{a}},{{b}}]` is a call once the tokens are numbers.
	const call = readCompactJson(content, ENGINE_MAX_JSON_DEPTH, { templateTokens: true });
	if (call?.kind !== "object") return content;
	if (call.members.get("jsonrpc")?.kind === "string") return content;

	call.members.set("jsonrpc", { kind: "string", text: '"2.0"' });
	if (!call.members.has("id")) {
		call.members.set("id", { kind: "other", text: String(DEFAULT_JSONRPC_ID) });
	}
	return compactObject(call.members);
}

/**
 * Whether the content is already a GraphQL-over-HTTP envelope. Readable JSON is
 * one when it is an object with a string `query`. Text that does not parse is
 * one when it opens as an object with a quoted key: a template such as
 * `{"query": {{q}}}` is the author's envelope and is not wrapped into a string.
 */
function isGraphqlEnvelope(content: string): boolean {
	const parsed = readCompactJson(content);
	if (!parsed) return OPENS_AS_JSON_OBJECT.test(content);
	return parsed.kind === "object" && parsed.members.get("query")?.kind === "string";
}

/** A bare GraphQL document wrapped as `{"query": <document>}`, an envelope as typed. */
export function graphqlWireBody(content: string): string {
	if (content === "" || isGraphqlEnvelope(content)) return content;
	return JSON.stringify({ query: content });
}

/** The content a body of @p mode is sent as. Every other mode is sent as stored. */
export function wireBodyContent(mode: string, content: string): string {
	if (mode === "jsonrpc") return jsonRpcWireBody(content);
	if (mode === "graphql") return graphqlWireBody(content);
	return content;
}
