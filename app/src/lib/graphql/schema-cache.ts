/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * In-memory GraphQL schema cache. The request builder sets the active target
 * and triggers ensureSchema; Monaco providers read getActiveSchema(). One
 * editor is visible at a time, so a single active target is sufficient.
 *
 * **The key is the endpoint plus the credentials it is reached with**, not the
 * endpoint alone. Since introspection composes engine-side (#228) it sends the
 * request's auth, so two environments pointing the same URL at different
 * credentials are two different results: keyed on the URL alone, the first
 * environment's schema - or its 401 - would be served to the second. Callers
 * never build the key; they hand over a target and the store derives it, so a
 * hand-written key cannot drift from a stored one.
 *
 * The credentials in the key are the **resolved** ones (#383). Keyed on the
 * auth block as typed, `{"mode":"inherit"}` is one value forever: editing the
 * ancestor collection it inherits from, or the environment variable its token
 * interpolates, left the key identical and served the schema fetched with the
 * old credential. The invariant is: if the wire request would differ, the key
 * differs. Callers hand over `resolvedAuth` alongside the unresolved `auth`
 * they still send.
 *
 * Headers are deliberately *not* part of the key: a header row is edited
 * keystroke by keystroke and re-keying on it would re-introspect the endpoint
 * as the user types. A hand-typed `Authorization` therefore still needs the
 * Refresh button, exactly as before this cache learned about auth.
 */

import { create } from "zustand";
import type { GraphQLSchema } from "graphql";
import { introspectSchema, IntrospectionError, type IntrospectionTarget } from "./introspect";

export type SchemaStatus = "idle" | "loading" | "ready" | "error";

/**
 * An endpoint to introspect: what to compose, plus the preview-resolved values
 * that decide identity.
 *
 * `resolvedUrl` and `resolvedAuth` are identity only and are never sent - the
 * wire request comes back from compose. They are in the key because they move
 * when a variable *value* changes, or when an ancestor's auth does, which no id
 * in the scope can see.
 */
export interface SchemaTarget extends IntrospectionTarget {
	resolvedUrl: string;
	/**
	 * The auth this request will actually send: `inherit` walked to its source
	 * and `{{variables}}` preview-resolved. `null` for "sends no credentials".
	 */
	resolvedAuth: Record<string, unknown> | null;
}

/** Why the last introspection of an entry failed, in terms the badge can show. */
export interface SchemaFailure {
	kind: IntrospectionError["kind"] | "unknown";
	message: string;
}

export interface SchemaEntry {
	status: SchemaStatus;
	/**
	 * The last schema that loaded, kept across a failed refresh. `status` says
	 * whether it is current; this says whether the editors can still complete.
	 */
	schema: GraphQLSchema | null;
	error: SchemaFailure | null;
	/** When `schema` was fetched. Null exactly when there is no schema. */
	fetchedAt: number | null;
}

/**
 * How many parsed schemas to retain. Each is a fully built `GraphQLSchema` -
 * megabytes for a large API - and the realistic working set is one per open
 * endpoint, so a handful covers switching between them without the cache
 * growing for the life of the process.
 */
export const SCHEMA_CACHE_MAX_ENTRIES = 8;

/*
 * A per-process salt over the identity digest. The store is in-memory and never
 * persisted, but the key is a plain object property visible to anything holding
 * the store - a bearer token spelled out there is a secret sitting somewhere it
 * is not needed, and the digest costs nothing.
 */
const SALT = (() => {
	const bytes = new Uint32Array(2);
	globalThis.crypto?.getRandomValues?.(bytes);
	return `${bytes[0]}:${bytes[1]}`;
})();

/**
 * A 64-bit FNV-1a digest of the salted input, as hex.
 *
 * Identity only - never a security boundary, and never reversed. Two variants
 * with different offset bases give 64 bits, which for a cache holding single
 * digits of entries makes a collision (the wrong schema served) unreachable in
 * practice, where a 32-bit digest merely makes it unlikely.
 */
function digest(input: string): string {
	const salted = `${SALT}:${input}`;
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < salted.length; i++) {
		const c = salted.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
	}
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * The cache identity of a target. In-memory only, and the credentials appear
 * as a digest rather than as themselves.
 */
export function schemaCacheKey(target: SchemaTarget): string {
	return JSON.stringify([
		target.resolvedUrl,
		target.collectionId ?? null,
		target.environmentId ?? null,
		digest(JSON.stringify(target.resolvedAuth ?? null)),
	]);
}

function toFailure(e: unknown): SchemaFailure {
	if (e instanceof IntrospectionError) return { kind: e.kind, message: e.message };
	return { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
}

interface SchemaCacheState {
	byKey: Record<string, SchemaEntry>;
	/** Keys least-recently-used first. Every key in `byKey` appears exactly once. */
	lru: string[];
	activeKey: string | null;
	/**
	 * Point at a target, by the key it hashes to.
	 *
	 * The target itself was kept beside the key for a while, because a surface
	 * outside the request builder - the context bar's GraphQL section - offered a
	 * Refresh, and `refreshSchema` takes a target rather than a key. That Refresh
	 * is gone (#1224), and nothing else ever asked for the target back, so the
	 * field went with it rather than staying as state nobody reads. Whoever needs
	 * one again should hold the target it already has, the way `GraphQLBody`
	 * does.
	 */
	setActiveTarget: (target: SchemaTarget | null) => void;
	/**
	 * Stop pointing at this target, if it is still the one being pointed at.
	 *
	 * Guarded rather than an unconditional clear: a request switch mounts the
	 * next GraphQL body before the old one's cleanup runs, so an unconditional
	 * clear on unmount would blank the target that was just set.
	 */
	clearActiveTarget: (target: SchemaTarget) => void;
	getActiveEntry: () => SchemaEntry | null;
	getActiveSchema: () => GraphQLSchema | null;
	getActiveStatus: () => SchemaStatus;
	/** Introspect only if this target has not been attempted yet. */
	ensureSchema: (target: SchemaTarget) => Promise<void>;
	/** Force a re-introspection regardless of any cached result for this target. */
	refreshSchema: (target: SchemaTarget) => Promise<void>;
}

/**
 * Write one entry, marking it most-recently-used and evicting past the cap.
 *
 * The active entry is never evicted: it is the one the visible editor completes
 * against, and dropping it would silently downgrade a working editor.
 */
function withEntry(
	state: SchemaCacheState,
	key: string,
	entry: SchemaEntry
): Pick<SchemaCacheState, "byKey" | "lru"> {
	const byKey = { ...state.byKey, [key]: entry };
	const lru = [...state.lru.filter((k) => k !== key), key];
	while (lru.length > SCHEMA_CACHE_MAX_ENTRIES) {
		const victim = lru.find((k) => k !== state.activeKey && k !== key);
		if (!victim) break;
		lru.splice(lru.indexOf(victim), 1);
		delete byKey[victim];
	}
	return { byKey, lru };
}

export const useSchemaCache = create<SchemaCacheState>((set, get) => ({
	byKey: {},
	lru: [],
	activeKey: null,

	setActiveTarget: (target) =>
		set({ activeKey: target && target.url ? schemaCacheKey(target) : null }),

	clearActiveTarget: (target) => {
		if (get().activeKey === schemaCacheKey(target)) set({ activeKey: null });
	},

	getActiveEntry: () => {
		const { activeKey, byKey } = get();
		return activeKey ? (byKey[activeKey] ?? null) : null;
	},

	getActiveSchema: () => get().getActiveEntry()?.schema ?? null,

	getActiveStatus: () => get().getActiveEntry()?.status ?? "idle",

	ensureSchema: async (target) => {
		if (!target.url) return;
		const existing = get().byKey[schemaCacheKey(target)];
		if (existing && existing.status !== "idle") return;
		await get().refreshSchema(target);
	},

	refreshSchema: async (target) => {
		if (!target.url) return;
		const key = schemaCacheKey(target);
		/*
		 * Keep the last good schema through the refresh, and through its failure.
		 * Nulling it on the way into `loading` downgraded the editor to
		 * syntax-only for the length of every manual refresh (markers flickering
		 * in and out), and nulling it again on error threw away a schema that is
		 * still the best answer available - a refresh that 401s does not make the
		 * types the user was completing against wrong.
		 */
		const previous = get().byKey[key];
		const lastGood = previous?.schema ?? null;
		const lastGoodAt = lastGood ? (previous?.fetchedAt ?? null) : null;
		set((s) =>
			withEntry(s, key, {
				status: "loading",
				schema: lastGood,
				error: null,
				fetchedAt: lastGoodAt,
			})
		);
		try {
			const schema = await introspectSchema(target);
			set((s) =>
				withEntry(s, key, { status: "ready", schema, error: null, fetchedAt: Date.now() })
			);
		} catch (e) {
			set((s) =>
				withEntry(s, key, {
					status: "error",
					schema: lastGood,
					error: toFailure(e),
					fetchedAt: lastGoodAt,
				})
			);
		}
	},
}));
