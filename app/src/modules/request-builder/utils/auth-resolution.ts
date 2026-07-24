/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Resolving a request's auth down to the record the engine is sent.
 *
 * This file used to be `auth-mapping.ts` and was mostly a translator: the
 * builder held a flat editor-local auth shape (`AuthType` + `AuthConfigState`),
 * so every load, save and execute had to convert to and from the domain
 * `RequestAuth`. The builder now holds `RequestAuth` itself, so the translation -
 * and the `apikey`/`api-key`, `in`/`addTo` rename traps that came with it - is
 * gone. What remains is the part that was never mapping: walking the collection
 * chain for `inherit`, and flattening a concrete auth for the wire.
 */

import type { Collection, RequestAuth } from "@/types";

/**
 * Walk the ancestor chain leaf-first and return the first non-none auth.
 * Collections are always concrete auth sources (never inherit), so the first
 * non-none one found is the effective inherited auth for the request.
 *
 * Lives here rather than in the builder's `index.tsx`, where it started, because
 * the History run view resolves auth the same way when it replays a run.
 * `CLAUDE.md` forbids a third copy of the resolution rules, and a second one was
 * already one too many.
 */
export function resolveInheritedAuth(ancestors: Collection[]): Record<string, unknown> | undefined {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const auth = ancestors[i].auth;
		if (auth.mode !== "none") {
			// Spread the discriminated union into a plain record for the engine
			return { ...auth } as Record<string, unknown>;
		}
	}
	return undefined;
}

/** Convert a concrete RequestAuth (non-inherit) to the flat record the engine expects. */
export function authToRecord(
	auth: Exclude<RequestAuth, { mode: "inherit" }>
): Record<string, unknown> | undefined {
	if (auth.mode === "none") return undefined;
	return { ...auth } as Record<string, unknown>;
}

/**
 * The auth record to send for a request, given its own auth and the collection
 * chain it sits in: `inherit` walks the chain, a concrete mode is flattened, and
 * "none" sends nothing. Both send paths - the builder's execute and load test,
 * and the History run view's replay - call this instead of repeating the
 * three-way branch a third time. Callers still apply their own `{{variable}}`
 * resolution to the result, which is scope-bound and cannot live here.
 */
export function resolveAuthForSend(
	auth: RequestAuth,
	ancestors: Collection[]
): Record<string, unknown> | undefined {
	return auth.mode === "inherit" ? resolveInheritedAuth(ancestors) : authToRecord(auth);
}
