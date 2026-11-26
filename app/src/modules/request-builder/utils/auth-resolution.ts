/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A request's auth resolved down to the record the engine is sent. The builder holds `RequestAuth`
 * itself, so nothing translates to the domain shape: this walks the chain for `inherit` and
 * flattens a concrete auth for the wire.
 */

import { containsVariableToken } from "@/constants/variables";
import { deferredNamesIn } from "@/lib/deferred-note";
import type { Collection, OAuth2Config, RequestAuth } from "@/types";

/** Where a descendant's `inherit` lands - see {@link resolveAuthSource}. */
export interface AuthSource {
	/** The ancestor whose auth is inherited, or null when nothing is. */
	source: Collection | null;
	/**
	 * The ancestor that stopped the walk by being explicitly `noauth`, if any. Non-null implies
	 * `source` is null: the chain deliberately sends no credentials, a different answer from
	 * "nobody configured any", worded differently in the UI.
	 */
	blockedBy: Collection | null;
}

/**
 * Substitute an in-progress edit for one collection's auth before walking the chain, so a dirty
 * Auth tab's chain and the context bar agree with the picker, not the last save (#1483). A no-op
 * when the draft is undefined, the usual no-edit case.
 */
export function withDraftAuth(
	ancestors: Collection[],
	collectionId: string,
	draftAuth: Collection["auth"] | undefined
): Collection[] {
	if (!draftAuth) return ancestors;
	return ancestors.map((c) => (c.id === collectionId ? { ...c, auth: draftAuth } : c));
}

/**
 * Whether the Auth tab's draft says something the stored collection does not. A draft can briefly
 * equal the stored value (a save landed, the entry not yet dropped), so "a draft exists" is not
 * "unsaved"; compared by serialised value, as the tab's `isDirty` is. `POST /compose` walks the
 * stored row, so a differing draft is what the context bar describes and the request does not yet
 * send.
 */
export function isUnsavedAuthDraft(
	stored: Collection["auth"],
	draftAuth: Collection["auth"] | undefined
): boolean {
	return draftAuth !== undefined && JSON.stringify(draftAuth) !== JSON.stringify(stored);
}

/**
 * Walk the ancestors leaf-first for the auth a descendant's `inherit` resolves to. Collections are
 * always concrete sources, so the first that configures auth wins, except that an explicit `noauth`
 * ends the walk instead of being stepped over (`RequestAuth`). Here, shared, because the History
 * run view resolves auth the same way on replay, and the chain views (`InheritanceChain`,
 * `AuthInheritBanner`) must agree with what is sent; `CLAUDE.md` forbids a copy of these rules.
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
	// The discriminated union spread into a plain record for the engine.
	return source ? ({ ...source.auth } as Record<string, unknown>) : undefined;
}

/**
 * The concrete auth after `inherit` is walked: {@link resolveAuthForSend}'s answer before
 * flattening. Offered beside the record form because a reader looking *inside* the credentials
 * needs the mode: the Data tab's column audit walks the fields a row binds (`{{data.user}}` in a
 * basic-auth username), typed by mode. A chain configuring nothing resolves to `none`, which an
 * unconfigured request sends anyway.
 */
export function resolveEffectiveAuth(
	auth: RequestAuth,
	ancestors: Collection[]
): Exclude<RequestAuth, { mode: "inherit" }> {
	if (auth.mode !== "inherit") return auth;
	// `resolveAuthSource` never returns a `none`/`noauth` source (it steps past the first, stops at
	// the second), so this is the configured auth or nothing.
	return resolveAuthSource(ancestors).source?.auth ?? { mode: "none" };
}

/**
 * The effective auth's OAuth 2.0 config as written (tokens unresolved), or null for another mode or
 * none.
 */
export function effectiveOAuth2Config(
	auth: RequestAuth,
	ancestors: Collection[]
): OAuth2Config | null {
	const effective = resolveEffectiveAuth(auth, ancestors);
	return effective.mode === "oauth2" ? effective.config : null;
}

/** Whether any OAuth 2.0 field holds a `{{token}}`; every string field can. */
export function oauth2HasTokens(config: OAuth2Config | null): boolean {
	return config !== null && containsVariableToken(JSON.stringify(config));
}

/**
 * The names in @p deferred that the *as-written* @p config uses. The resolved config cannot say: a
 * script-changeable name with a stored value is replaced, and the token gone. Stringifying reads
 * every field without a list that drifts as fields are added.
 */
export function oauth2DeferredNames(
	config: OAuth2Config | null,
	deferred: readonly string[]
): string[] {
	if (config === null) return [];
	return deferredNamesIn(deferred, [JSON.stringify(config)]);
}

/** Convert a concrete RequestAuth (non-inherit) to the flat record the engine expects. */
export function authToRecord(
	auth: Exclude<RequestAuth, { mode: "inherit" }>
): Record<string, unknown> | undefined {
	// `noauth` differs from `none` only when *walked*: on the request both send nothing, and
	// neither is a mode the engine resolves.
	if (auth.mode === "none" || auth.mode === "noauth") return undefined;
	return { ...auth } as Record<string, unknown>;
}

/**
 * The auth record to send, given the request's auth and its chain: `inherit` walks, a concrete mode
 * flattens, "none" sends nothing. Both send paths (the builder's execute and load test, the History
 * run view's replay) call this rather than repeat the branch. Callers still resolve `{{variables}}`
 * themselves, which is scope-bound.
 */
export function resolveAuthForSend(
	auth: RequestAuth,
	ancestors: Collection[]
): Record<string, unknown> | undefined {
	return authToRecord(resolveEffectiveAuth(auth, ancestors));
}
