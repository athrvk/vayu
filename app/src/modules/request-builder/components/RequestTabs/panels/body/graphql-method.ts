/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Choosing GraphQL on a brand-new request changes its method, and leaving
 * GraphQL puts the method back (issue #1228).
 *
 * A new request is a `GET`, and GraphQL-over-HTTP means something different on
 * one: the document travels as query parameters rather than as the JSON
 * envelope, and a mutation may not be sent that way at all. Vayu sent the
 * envelope as a body on the `GET` regardless, which that specification leaves
 * undefined - the endpoint answered `400 Bad Request`, eleven bytes, and
 * nothing on screen connected the two. The engine now sends a GraphQL `GET`
 * the way the specification says (`engine/src/http/graphql_body.cpp`); this is
 * the other half, which is that the mode a user picks should not quietly hand
 * them the transport they did not want.
 *
 * So the mode moves the method the way it already moves a header - the
 * reversible side effect of `utils/auto-header.ts`, applied to the one field
 * that is not a header row. Only from `GET`, only to `POST`, and only back to
 * what it replaced: a method the user chose is never overridden, and a method
 * they have chosen *since* is never reverted, which is the same rule
 * `switchAutoHeader` states as "a row edited by hand is no longer ours".
 *
 * Ownership used to live in a ref the provider held, keyed by request id -
 * which meant nothing survived a reload, and a stale `POST` was then
 * indistinguishable from one the user picked (issue #1505, the same gap
 * #1481 closed for the Content-Type and Accept rows). `Request.methodSource`
 * is the fix, on the row itself rather than beside it: `MethodSelector`
 * clears it the moment the user picks a method by hand, the same way retyping
 * a marked header row clears `KeyValueEntry.source`.
 *
 * The rule lives here rather than in the click handler for the reason
 * `content-type.ts` gives: the only way to exercise a rule inside that handler
 * is to drive a Radix `Select` through jsdom, which does not commit a value
 * there.
 */

import type { HttpMethod, MethodSource } from "@/types";
import type { BodyMode } from "../../../../types";

/**
 * The method a GraphQL body is sent with when the app picks one.
 *
 * `POST` is what every other client creates a GraphQL request as, and the one
 * method the specification allows a mutation on.
 */
export const GRAPHQL_METHOD: HttpMethod = "POST";

/**
 * The method this side effect is willing to replace.
 *
 * Only the default. Any other method is one someone chose - `PUT` on a GraphQL
 * endpoint is unusual, and that is exactly why it must survive a mode change.
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
 * Staying inside GraphQL (a re-selection of the same mode) keeps the marker
 * rather than re-deriving it, so the method the user has since chosen is not
 * overwritten by a second visit to the mode they are already in.
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

	// Leaving GraphQL. The revert is conditional on the method still being the
	// one the marker wrote: a user who has picked `PUT` since means it, and
	// handing them back `GET` would be the silent rewrite this rule exists to
	// avoid - in the other direction. `MethodSelector` already clears the
	// marker the moment a method is picked by hand, so this second check only
	// matters for a marker something other than this file wrote - MCP, import -
	// which must not be trusted past what it actually wrote.
	if (!ours) return { method };
	if (method !== GRAPHQL_METHOD) return { method };
	return { method: REPLACEABLE_METHOD };
}

/**
 * Whether a GraphQL body sent with this method travels in the URL.
 *
 * True only for the case the Query header's notice describes: a `GET` the user
 * chose themselves, or one an import wrote. The mode switch above makes it
 * unreachable for a request built in the app from a fresh `GET`, which is why
 * the notice explains a transport rather than reporting an error - `GET` is a
 * legitimate way to send a query, and the wrong one for a mutation.
 *
 * The mode is not a parameter because the one caller renders only for the
 * GraphQL mode; the fact this answers is about the method alone.
 */
export function sendsGraphQLInTheUrl(method: HttpMethod): boolean {
	return method === REPLACEABLE_METHOD;
}
