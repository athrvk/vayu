/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * In-memory GraphQL schema cache. The request builder sets the active target and triggers
 * ensureSchema; Monaco providers read getActiveSchema(). One editor is visible at a time, so a
 * single active target is enough.
 *
 * **The key is the endpoint plus the credentials it is reached with**, not the endpoint alone.
 * Introspection composes engine-side (#228) and sends the request's auth, so two environments
 * pointing one URL at different credentials are two results: keyed on the URL alone, the first
 * environment's schema (or its 401) would be served to the second. Callers never build the key;
 * they hand over a target and the store derives it, so a hand-written key cannot drift from a
 * stored one.
 *
 * The credentials in the key are the **resolved** ones (#383). Keyed on the auth block as typed,
 * `{"mode":"inherit"}` is one value forever: editing the ancestor collection it inherits from, or
 * the environment variable its token interpolates, would leave the key identical and serve the
 * schema fetched with the old credential. The invariant: if the wire request would differ, the key
 * differs. Callers hand over `resolvedAuth` beside the unresolved `auth` they still send.
 *
 * Headers are deliberately *not* part of the key: a header row is edited keystroke by keystroke,
 * and re-keying on it would re-introspect the endpoint as the user types. So a hand-typed
 * `Authorization` still needs the Refresh button.
 *
 * **Loading on its own is conditional; loading on request is not.** `ensureSchema` only introspects
 * an endpoint the user has already contacted (`approved-endpoints.ts`), judged on the URL the
 * introspection would be sent to. `refreshSchema` is the user asking, so it always goes and
 * approves the endpoint it reached.
 */

import { create } from "zustand";
import type { GraphQLSchema } from "graphql";
import type { ComposedRequest } from "@/types";
import {
	composeIntrospection,
	introspectSchema,
	IntrospectionError,
	type IntrospectionTarget,
} from "./introspect";
import { approveEndpoint, isEndpointApproved } from "./approved-endpoints";

export type SchemaStatus = "idle" | "loading" | "ready" | "error";

/**
 * An endpoint to introspect: what to compose, plus the preview-resolved values that decide
 * identity. `resolvedUrl` and `resolvedAuth` are identity only and never sent (the wire request
 * comes back from compose); they are in the key because they move when a variable *value* changes,
 * or an ancestor's auth does, which no id in the scope can see.
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
 * How many parsed schemas to retain. Each is a fully built `GraphQLSchema`, megabytes for a large
 * API, and the realistic working set is one per open endpoint, so a handful covers switching
 * between them without the cache growing for the life of the process.
 */
export const SCHEMA_CACHE_MAX_ENTRIES = 8;

/*
 * A per-process salt over the identity digest. The store is in-memory and never persisted, but the
 * key is a plain object property visible to anything holding the store: a bearer token spelled out
 * there is a secret where it is not needed, and the digest costs nothing.
 */
const SALT = (() => {
	const bytes = new Uint32Array(2);
	globalThis.crypto?.getRandomValues?.(bytes);
	return `${bytes[0]}:${bytes[1]}`;
})();

/**
 * A 64-bit FNV-1a digest of the salted input, as hex. Identity only, never a security boundary and
 * never reversed. Two variants with different offset bases give 64 bits, which for a cache of
 * single-digit entries makes a collision (the wrong schema served) unreachable in practice, where
 * 32 bits only makes it unlikely.
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
	 * Keys `ensureSchema` declined to load on its own - the endpoint is not
	 * approved, or could not be composed - so the badge offers Load schema.
	 * Left by `refreshSchema`, which is that offer taken up.
	 */
	awaitingLoad: Record<string, true>;
	/**
	 * Point at a target, by the key it hashes to. Only the key is kept: nothing reads the target
	 * back since the context bar's Refresh went (#1224), so a caller that needs one holds the
	 * target it already has, as `GraphQLBody` does.
	 */
	setActiveTarget: (target: SchemaTarget | null) => void;
	/**
	 * Stop pointing at this target, if it is still the one pointed at. Guarded rather than an
	 * unconditional clear: a request switch mounts the next GraphQL body before the old one's
	 * cleanup runs, so an unconditional clear on unmount would blank the target just set.
	 */
	clearActiveTarget: (target: SchemaTarget) => void;
	getActiveEntry: () => SchemaEntry | null;
	getActiveSchema: () => GraphQLSchema | null;
	getActiveStatus: () => SchemaStatus;
	/**
	 * Introspect only if this target has not been attempted yet, and only if its
	 * endpoint is one the user has already contacted. Otherwise the key is
	 * recorded in `awaitingLoad` and nothing is sent.
	 */
	ensureSchema: (target: SchemaTarget) => Promise<void>;
	/**
	 * Force a re-introspection regardless of any cached result for this target,
	 * and approve the endpoint it reaches. `composed` is the composition the
	 * caller already judged, so the request goes to exactly that.
	 */
	refreshSchema: (target: SchemaTarget, composed?: ComposedRequest) => Promise<void>;
}

/**
 * Write one entry, marking it most-recently-used and evicting past the cap. The active entry is
 * never evicted: the visible editor completes against it, and dropping it would silently downgrade
 * a working editor.
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
	awaitingLoad: {},

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
		const key = schemaCacheKey(target);
		const attempted = () => {
			const existing = get().byKey[key];
			return !!existing && existing.status !== "idle";
		};
		if (attempted()) return;
		const decline = () =>
			set((s) =>
				s.awaitingLoad[key] ? s : { awaitingLoad: { ...s.awaitingLoad, [key]: true } }
			);

		let composed: ComposedRequest;
		try {
			composed = await composeIntrospection(target);
		} catch {
			// Nothing to judge, so nothing is sent; Load schema composes again
			// and puts the engine's answer on the badge.
			return decline();
		}
		// Composing is async: a Refresh pressed meanwhile has the key loading.
		if (attempted()) return;
		if (!isEndpointApproved(composed.url)) return decline();
		await get().refreshSchema(target, composed);
	},

	refreshSchema: async (target, composed) => {
		if (!target.url) return;
		const key = schemaCacheKey(target);
		/*
		 * Keep the last good schema through the refresh and through its failure. Nulled on the way
		 * into `loading`, the editor would drop to syntax-only for every manual refresh (markers
		 * flickering in and out); nulled on error, it would lose a schema that is still the best
		 * answer available, since a refresh that 401s does not make the types the user was
		 * completing against wrong.
		 */
		const previous = get().byKey[key];
		const lastGood = previous?.schema ?? null;
		const lastGoodAt = lastGood ? (previous?.fetchedAt ?? null) : null;
		set((s) => ({
			...withEntry(s, key, {
				status: "loading",
				schema: lastGood,
				error: null,
				fetchedAt: lastGoodAt,
			}),
			awaitingLoad: Object.fromEntries(
				Object.entries(s.awaitingLoad).filter(([k]) => k !== key)
			),
		}));
		try {
			const request = composed ?? (await composeIntrospection(target));
			approveEndpoint(request.url);
			const schema = await introspectSchema(target, request);
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
