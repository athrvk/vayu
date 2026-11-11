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
 *
 * A GraphQL GET has no body at all: the engine sends the document as query
 * parameters (`graphql_get_parameters`), which `graphqlGetQuery` restates
 * (#3211).
 */

import { compactObject, readCompactJson, type JsonNode } from "./compact-json";
import type { SnippetBody } from "./types";
import { splitFragment } from "@/modules/request-builder/utils/query-encoding";
import { maskTokens } from "@/modules/request-builder/utils/path-variables";

/** `constants::request_body::MAX_JSON_DEPTH`: a JSON-RPC call nested deeper is left as typed. */
const ENGINE_MAX_JSON_DEPTH = 128;

/** What `curl_easy_escape` leaves alone. */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

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

/**
 * `curl_easy_escape`, the escaper behind the engine's `percent_encode`: the
 * UTF-8 bytes of the text, every one outside `A-Za-z0-9-._~` as an uppercase
 * `%XX`. `encodeURIComponent` leaves `!'()*` raw, so it writes another URL.
 */
export function curlEscape(text: string): string {
	let out = "";
	for (const byte of new TextEncoder().encode(text)) {
		const char = String.fromCharCode(byte);
		out += UNRESERVED.test(char)
			? char
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Whether @p node is a JSON `null`. */
function isNull(node: JsonNode): boolean {
	return node.kind === "other" && node.text === "null";
}

/**
 * One GraphQL envelope member as a query parameter, or `null` for one with
 * nothing to send, or `undefined` for one the URL cannot carry. `operationName`
 * is a string, `variables` and `extensions` are objects written as the engine's
 * compact dump, and an explicit `null` is the same as leaving the member out.
 */
function envelopeParameter(key: string, node: JsonNode): string | null | undefined {
	if (key === "query") return `query=${curlEscape(JSON.parse(node.text) as string)}`;
	if (key !== "operationName" && key !== "variables" && key !== "extensions") return undefined;
	if (isNull(node)) return null;
	if (key === "operationName") {
		return node.kind === "string"
			? `operationName=${curlEscape(JSON.parse(node.text) as string)}`
			: undefined;
	}
	return node.kind === "object" ? `${key}=${curlEscape(node.text)}` : undefined;
}

/**
 * The query string a GraphQL GET travels as, or undefined when the document
 * travels in the body like every other request: `graphql_get_parameters`
 * (`engine/src/http/graphql_body.cpp`). A bare document is the whole `query`
 * parameter. An envelope becomes one parameter per member in the author's
 * order; one the engine cannot read, or holding a member with no parameter to
 * carry it, keeps the body. A `{{name}}` inside a bare document is encoded with
 * the rest, so the unresolved view shows `%7B%7Bname%7D%7D` where the engine,
 * which resolves first, sends the value.
 */
export function graphqlGetQuery(content: string): string | undefined {
	if (content === "") return undefined;
	if (!isGraphqlEnvelope(content)) return `query=${curlEscape(content)}`;

	const envelope = readCompactJson(content, ENGINE_MAX_JSON_DEPTH);
	if (envelope?.kind !== "object") return undefined;

	const parameters: string[] = [];
	for (const [key, node] of envelope.members) {
		const parameter = envelopeParameter(key, node);
		if (parameter === undefined) return undefined;
		if (parameter !== null) parameters.push(parameter);
	}
	return parameters.join("&");
}

/**
 * The GraphQL document a request carries in its URL instead of a body, or
 * undefined for any other request: `graphql_url_transport`'s gate
 * (`engine/src/http/form_body.cpp`) - a GET whose body is the GraphQL mode with
 * content. The text is as stored; the engine resolves `{{name}}` in it before it
 * builds the query, so a caller that shows the sent URL resolves it first and
 * only then asks {@link graphqlGetQuery}, which can still decline it.
 */
export function graphqlUrlContent(method: string, body: unknown): string | undefined {
	if (method.toUpperCase() !== "GET" || typeof body !== "object" || body === null)
		return undefined;
	const { mode, content } = body as SnippetBody;
	return mode === "graphql" && content ? content : undefined;
}

/**
 * @p url with @p query appended, as the engine's `url_with_query`: the fragment
 * is split off first and put back last, a URL with no `?` gets one, and a
 * separator is added unless the URL already ends in `?` or `&`. The engine reads
 * a raw `#` and `?`, resolved by then; this sees the URL before resolution, so
 * both are looked for outside a `{{token}}`, where a name may hold either.
 */
export function urlWithQuery(url: string, query: string): string {
	if (query === "") return url;
	const { base: target, fragment } = splitFragment(url);
	let separator = "";
	if (!maskTokens(target).includes("?")) separator = "?";
	else if (target !== "" && !target.endsWith("?") && !target.endsWith("&")) separator = "&";
	return `${target}${separator}${query}${fragment}`;
}

/** The content a body of @p mode is sent as. Every other mode is sent as stored. */
export function wireBodyContent(mode: string, content: string): string {
	if (mode === "jsonrpc") return jsonRpcWireBody(content);
	if (mode === "graphql") return graphqlWireBody(content);
	return content;
}
