/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Choosing GraphQL on a new request changes its method, and leaving GraphQL puts it back (#1228). A
 * new request is a `GET`, and GraphQL-over-HTTP differs there: the document goes as query
 * parameters, not the JSON envelope, and a mutation may not be sent at all. An envelope body on a
 * `GET` is undefined by the specification (the endpoint answered an unexplained `400`). The engine
 * sends a GraphQL `GET` the specification's way (`engine/src/http/graphql_body.cpp`); this half
 * keeps the mode from handing the user a transport they did not want.
 *
 * The mode moves the method as it moves a header (`utils/auto-header.ts`'s reversible side effect,
 * on the one field that is not a header row): only from `GET`, only to `POST`, only back to what it
 * replaced. A user-chosen method is never overridden and one chosen *since* never reverted,
 * `switchAutoHeader`'s "a row edited by hand is no longer ours". Ownership is
 * `Request.methodSource` (#1505, the gap #1481 closed for Content-Type and Accept), on the row so
 * it survives a reload; `MethodSelector` clears it on a hand pick, as retyping a marked header
 * clears `KeyValueEntry.source`. Not in the click handler, for `content-type.ts`'s jsdom reason.
 */

import type { HttpMethod, MethodSource } from "@/types";
import type { BodyMode } from "../../../../types";

/**
 * The method the app picks for a GraphQL body: what every other client creates one as, and the only
 * one a mutation may use.
 */
export const GRAPHQL_METHOD: HttpMethod = "POST";

/**
 * The one method this side effect replaces, the default: any other was chosen, and `PUT` on GraphQL
 * is unusual, which is why it must survive.
 */
const REPLACEABLE_METHOD: HttpMethod = "GET";

export interface GraphQLMethodSwitch {
	/** The method for the new mode. The same one when nothing changed. */
	method: HttpMethod;
	/** The marker for the new mode, or undefined when this side effect owns nothing. */
	methodSource?: MethodSource;
}

/**
 * Set the method the new mode needs, or put back the one the old mode replaced.
 *
 * @param mode         The body mode being switched *to*.
 * @param method       The request's current method.
 * @param methodSource The request's current marker.
 *
 * Re-selecting GraphQL keeps the marker rather than re-deriving it, so a method chosen since is not
 * overwritten by a second visit.
 */
export function switchGraphQLMethod(
	mode: BodyMode,
	method: HttpMethod,
	methodSource: MethodSource | undefined
): GraphQLMethodSwitch {
	const ours = methodSource === "graphql";

	if (mode === "graphql") {
		if (ours) return { method, methodSource: "graphql" };
		if (method !== REPLACEABLE_METHOD) return { method };
		return { method: GRAPHQL_METHOD, methodSource: "graphql" };
	}

	// Leaving GraphQL: revert only if the method is still the one the marker wrote, since a user
	// who picked `PUT` since means it. `MethodSelector` clears the marker on a hand pick, so this
	// check matters for a marker something else wrote (MCP, import), not trusted past what it
	// wrote.
	if (!ours) return { method };
	if (method !== GRAPHQL_METHOD) return { method };
	return { method: REPLACEABLE_METHOD };
}

/**
 * Whether a GraphQL body on this method travels in the URL: only for a `GET` the user chose or an
 * import wrote, since the mode switch moves a fresh `GET` away. So the Query header's notice
 * explains a transport, not an error (`GET` suits a query, not a mutation). No mode parameter: the
 * one caller renders only in GraphQL mode.
 */
export function sendsGraphQLInTheUrl(method: HttpMethod): boolean {
	return method === REPLACEABLE_METHOD;
}
