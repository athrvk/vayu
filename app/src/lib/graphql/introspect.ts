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
	const res = await apiService.executeRequest(
		buildIntrospectionRequest(composed, target.environmentId)
	);
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Introspection failed: HTTP ${res.status}`);
	}
	let parsed: { data?: unknown; errors?: { message: string }[] };
	try {
		parsed = JSON.parse(res.bodyRaw);
	} catch {
		throw new Error("Introspection response was not valid JSON");
	}
	if (parsed.errors?.length) {
		throw new Error(parsed.errors.map((e) => e.message).join("; "));
	}
	if (!parsed.data) {
		throw new Error("Introspection response had no data");
	}
	return buildClientSchema(parsed.data as Parameters<typeof buildClientSchema>[0]);
}
