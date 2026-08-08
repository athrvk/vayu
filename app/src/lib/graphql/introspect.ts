/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Fetches a GraphQL schema by sending the standard introspection query through
 * the engine (`POST /compose` then `POST /execute`), avoiding CORS and giving
 * introspection the same credentials the request itself would send.
 *
 * Composition is the engine's (issue #226): the endpoint's `{{variables}}` and
 * its auth block - `inherit` walked through the collection chain, OAuth 2.0
 * included - are resolved by `POST /compose`, and the introspection query is
 * overlaid onto what comes back. Introspection therefore holds no resolution
 * logic of its own. It used to send only the request's header rows, so any
 * endpoint whose credentials came from the Auth panel answered 401 and the
 * schema never loaded (issue #228).
 *
 * The execution is **transient** (issue #382): the engine runs it in full but
 * records no run row. Reusing `POST /execute` unqualified made every schema
 * load an ordinary design run - a History entry the user never made, holding
 * hundreds of KB of introspection response and the credentials the engine had
 * resolved into the request headers, and evicting a real run each time because
 * retention is count-based. Nothing about a background fetch belongs on disk,
 * so the flag rides every introspection rather than being a caller's choice.
 */

import { buildClientSchema, getIntrospectionQuery, type GraphQLSchema } from "graphql";
import { apiService } from "@/services/api";
import type { ComposedRequest, ExecuteRequestRequest } from "@/types";

/**
 * Why introspection failed, in the terms the user can act on.
 *
 * Every failure used to arrive as a bare `Error` and collapse into one badge
 * reading "introspection failed", so "your token expired" and "this endpoint
 * does not allow introspection" - opposite fixes - looked identical (#383).
 * The kind is decided here because this is the only layer that still holds the
 * evidence: the HTTP status, the GraphQL error list, the raw body.
 */
export type IntrospectionFailureKind =
	| "auth"
	| "unsupported"
	| "http"
	| "network"
	| "parse"
	| "too-large";

export class IntrospectionError extends Error {
	constructor(
		readonly kind: IntrospectionFailureKind,
		message: string
	) {
		super(message);
		this.name = "IntrospectionError";
	}
}

/**
 * The largest introspection response accepted, in characters of the raw body.
 *
 * Generous - a GitHub-scale schema introspects to a few MB - but finite: the
 * parse below is synchronous, so an unbounded response is an unbounded freeze
 * of the renderer's only thread. A cap that is never hit in practice is still
 * the difference between a readable error and a hung window.
 */
export const MAX_INTROSPECTION_CHARS = 20 * 1024 * 1024;

/** A server that says this in its errors has introspection turned off. */
const INTROSPECTION_DISABLED = /introspection/i;

/**
 * Yield to the event loop so the browser can paint before the parse.
 *
 * `JSON.parse` of a multi-MB body plus `buildClientSchema` is tens of
 * milliseconds of main thread with no interruption point. Awaiting a macrotask
 * first does not make it cheaper - it makes it *late*, after the frame that
 * shows "loading", instead of inside the same synchronous run as the request
 * that produced it. A worker would move the cost off-thread entirely and is
 * disproportionate for a once-per-endpoint fetch.
 */
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * What introspection needs in order to compose: the endpoint as the user typed
 * it, plus the scope that resolves it. Nothing here is resolved by the
 * renderer - `{{vars}}` and `inherit` go over unresolved on purpose, because
 * resolving them twice is the defect `POST /compose` exists to prevent.
 */
export interface IntrospectionTarget {
	/** Endpoint URL as typed, `{{variables}}` intact. */
	url: string;
	/** Header rows as typed (enabled-only, flattened), `{{variables}}` intact. */
	headers: Record<string, string>;
	/** The request's auth block, `inherit` included. Absent means no auth. */
	auth?: Record<string, unknown>;
	/** Scopes the variable chain and the `inherit` walk. */
	collectionId?: string;
	environmentId?: string;
}

/**
 * Overlay the introspection query onto a composed payload.
 *
 * Only the three composed fields introspection needs are carried over - url,
 * headers and the concrete auth. The rest of the composed request is
 * deliberately dropped: its body is not an introspection query, and its script
 * parts belong to sending the request, not to loading a schema in the
 * background.
 *
 * `environmentId` is the target's, not the composed payload's: it scopes the
 * cookie jar the engine sends through, and dropping it introspected a
 * cookie-session endpoint in the no-environment jar - so the endpoint answered
 * real requests and failed introspection with a confusing auth error (#382).
 */
export function buildIntrospectionRequest(
	composed: ComposedRequest,
	environmentId?: string
): ExecuteRequestRequest {
	const request: ExecuteRequestRequest = {
		method: "POST",
		url: composed.url,
		headers: { ...composed.headers, "Content-Type": "application/json" },
		// The engine expects a structured body ({ mode, content }), not a raw
		// string - content is the serialized JSON the server receives.
		body: { mode: "json", content: JSON.stringify({ query: getIntrospectionQuery() }) },
		// Nobody sent this request, so nothing about it belongs in History
		// (#382). Without the flag every schema load filed a design run, stored
		// the resolved credentials in its trace, and evicted a real run.
		transient: true,
		...(environmentId ? { environmentId } : {}),
	};
	// Compose erases `auth` when it resolves to nothing, and never returns a
	// still-`inherit` block; either way an absent field is the engine's "send
	// nothing", so only a concrete block is forwarded.
	const mode = typeof composed.auth?.mode === "string" ? composed.auth.mode : undefined;
	if (composed.auth && mode !== "inherit") request.auth = composed.auth;
	return request;
}

export async function introspectSchema(target: IntrospectionTarget): Promise<GraphQLSchema> {
	// Compose and execute are the two calls that can fail without an answer -
	// the engine being down, the collection being gone, the endpoint refusing
	// the connection. All of them mean "never got a reply", which is a different
	// fix from anything the endpoint itself said.
	let res;
	try {
		const composed = await apiService.composeRequest({
			request: {
				method: "POST",
				url: target.url,
				headers: target.headers,
				...(target.auth ? { auth: target.auth } : {}),
			},
			collectionId: target.collectionId,
			environmentId: target.environmentId,
		});
		res = await apiService.executeRequest(
			buildIntrospectionRequest(composed, target.environmentId)
		);
	} catch (e) {
		throw new IntrospectionError(
			"network",
			`Could not reach the endpoint: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	if (res.status === 401 || res.status === 403) {
		throw new IntrospectionError(
			"auth",
			`The endpoint rejected these credentials (HTTP ${res.status}). Check the request's auth.`
		);
	}
	if (res.status < 200 || res.status >= 300) {
		throw new IntrospectionError(
			"http",
			`The endpoint answered HTTP ${res.status}; introspection needs a 2xx.`
		);
	}
	if (res.bodyRaw.length > MAX_INTROSPECTION_CHARS) {
		throw new IntrospectionError(
			"too-large",
			`The introspection response is ${Math.round(res.bodyRaw.length / (1024 * 1024))}MB, over the ${MAX_INTROSPECTION_CHARS / (1024 * 1024)}MB limit.`
		);
	}

	await yieldToPaint();

	let parsed: { data?: unknown; errors?: { message: string }[] };
	try {
		parsed = JSON.parse(res.bodyRaw);
	} catch {
		throw new IntrospectionError(
			"parse",
			"The endpoint answered, but not with JSON - it may not be a GraphQL endpoint."
		);
	}
	if (parsed.errors?.length) {
		const detail = parsed.errors.map((e) => e.message).join("; ");
		// "GraphQL introspection is not allowed" and its wording-by-server
		// variants all name introspection; anything else the server rejected is
		// its own message, which is more useful verbatim than classified.
		throw INTROSPECTION_DISABLED.test(detail)
			? new IntrospectionError(
					"unsupported",
					`This endpoint disallows introspection: ${detail}`
				)
			: new IntrospectionError("parse", `The endpoint answered with errors: ${detail}`);
	}
	if (!parsed.data) {
		throw new IntrospectionError(
			"parse",
			"The endpoint answered with no introspection data - it may not be a GraphQL endpoint."
		);
	}
	try {
		return buildClientSchema(parsed.data as Parameters<typeof buildClientSchema>[0]);
	} catch (e) {
		// JSON that is not an introspection result: a gateway's own envelope, a
		// truncated body, a schema graphql-js refuses. Unclassified this
		// surfaced as a raw library message about `__schema`.
		throw new IntrospectionError(
			"parse",
			`The introspection result could not be read as a schema: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}
