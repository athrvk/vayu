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

/** Where a descendant's `inherit` lands - see {@link resolveAuthSource}. */
export interface AuthSource {
	/** The ancestor whose auth is inherited, or null when nothing is. */
	source: Collection | null;
	/**
	 * The ancestor that stopped the walk by being explicitly `noauth`, when one
	 * did. Non-null implies `source` is null: the chain deliberately sends no
	 * credentials, which is a different answer from "nobody configured any" and
	 * is worded differently in the UI.
	 */
	blockedBy: Collection | null;
}

/**
 * Walk the ancestor chain leaf-first for the auth a descendant `inherit`
 * resolves to. Collections are always concrete auth sources (never inherit), so
 * the first one that configures auth wins - except that an explicit `noauth`
 * terminates the walk instead of being stepped over (see `RequestAuth`).
 *
 * Lives here rather than in the builder's `index.tsx`, where it started, because
 * the History run view resolves auth the same way when it replays a run, and the
 * two chain views (`InheritanceChain`, `AuthInheritBanner`) have to agree with
 * what actually gets sent. `CLAUDE.md` forbids a third copy of the resolution
 * rules, and a second one was already one too many.
 */
export function resolveAuthSource(ancestors: Collection[]): AuthSource {
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const collection = ancestors[i];
		if (collection.auth.mode === "noauth") return { source: null, blockedBy: collection };
		if (collection.auth.mode !== "none") return { source: collection, blockedBy: null };
	}
	return { source: null, blockedBy: null };
}

/** The inherited auth as the flat record the engine expects, or undefined for none. */
export function resolveInheritedAuth(ancestors: Collection[]): Record<string, unknown> | undefined {
	const { source } = resolveAuthSource(ancestors);
	// Spread the discriminated union into a plain record for the engine
	return source ? ({ ...source.auth } as Record<string, unknown>) : undefined;
}

/**
 * The concrete auth a request carries once `inherit` has been walked - the same
 * answer {@link resolveAuthForSend} flattens, before it is flattened.
 *
 * Offered beside the record form because a reader that has to look *inside* the
 * credentials cannot use a `Record<string, unknown>` without re-deriving the
 * mode: the Data tab's column audit walks the fields a data row binds
 * (`{{data.user}}` in a basic-auth username), and that walk is typed by mode.
 * A request whose chain configures nothing resolves to `none`, which is what an
 * unconfigured request sends anyway.
 */
export function resolveEffectiveAuth(
	auth: RequestAuth,
	ancestors: Collection[]
): Exclude<RequestAuth, { mode: "inherit" }> {
	if (auth.mode !== "inherit") return auth;
	// `resolveAuthSource` never returns a `none`/`noauth` source - it steps past
	// the first and stops at the second - so this is the configured auth or
	// nothing, never a source that says "send nothing" wearing a mode.
	return resolveAuthSource(ancestors).source?.auth ?? { mode: "none" };
}

/** Convert a concrete RequestAuth (non-inherit) to the flat record the engine expects. */
export function authToRecord(
	auth: Exclude<RequestAuth, { mode: "inherit" }>
): Record<string, unknown> | undefined {
	// `noauth` only differs from `none` when *walked* - on the request itself both
	// mean send nothing, and neither is a mode the engine resolves.
	if (auth.mode === "none" || auth.mode === "noauth") return undefined;
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
	return authToRecord(resolveEffectiveAuth(auth, ancestors));
}
