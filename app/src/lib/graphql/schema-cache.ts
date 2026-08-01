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
 * Headers are deliberately *not* part of the key: a header row is edited
 * keystroke by keystroke and re-keying on it would re-introspect the endpoint
 * as the user types. A hand-typed `Authorization` therefore still needs the
 * Refresh button, exactly as before this cache learned about auth.
 */

import { create } from "zustand";
import type { GraphQLSchema } from "graphql";
import { introspectSchema, type IntrospectionTarget } from "./introspect";

export type SchemaStatus = "idle" | "loading" | "ready" | "error";

/**
 * An endpoint to introspect: what to compose, plus the preview-resolved URL.
 *
 * `resolvedUrl` is identity only and is never sent - the wire URL comes back
 * from compose. It is in the key because it moves when a variable *value* the
 * URL interpolates changes, which no id in the scope can see.
 */
export interface SchemaTarget extends IntrospectionTarget {
	resolvedUrl: string;
}

interface SchemaEntry {
	status: SchemaStatus;
	schema: GraphQLSchema | null;
	error: string | null;
	fetchedAt: number | null;
}

/**
 * The cache identity of a target. In-memory only - the store is never
 * persisted, which is what makes it safe for the auth block (secrets and all)
 * to appear here.
 */
export function schemaCacheKey(target: SchemaTarget): string {
	return JSON.stringify([
		target.resolvedUrl,
		target.collectionId ?? null,
		target.environmentId ?? null,
		target.auth ?? null,
	]);
}

interface SchemaCacheState {
	byKey: Record<string, SchemaEntry>;
	activeKey: string | null;
	setActiveTarget: (target: SchemaTarget | null) => void;
	getActiveSchema: () => GraphQLSchema | null;
	getActiveStatus: () => SchemaStatus;
	/** Introspect only if this target has not been attempted yet. */
	ensureSchema: (target: SchemaTarget) => Promise<void>;
	/** Force a re-introspection regardless of any cached result for this target. */
	refreshSchema: (target: SchemaTarget) => Promise<void>;
}

export const useSchemaCache = create<SchemaCacheState>((set, get) => ({
	byKey: {},
	activeKey: null,

	setActiveTarget: (target) =>
		set({ activeKey: target && target.url ? schemaCacheKey(target) : null }),

	getActiveSchema: () => {
		const { activeKey, byKey } = get();
		return activeKey ? (byKey[activeKey]?.schema ?? null) : null;
	},

	getActiveStatus: () => {
		const { activeKey, byKey } = get();
		return activeKey ? (byKey[activeKey]?.status ?? "idle") : "idle";
	},

	ensureSchema: async (target) => {
		if (!target.url) return;
		const existing = get().byKey[schemaCacheKey(target)];
		if (existing && existing.status !== "idle") return;
		await get().refreshSchema(target);
	},

	refreshSchema: async (target) => {
		if (!target.url) return;
		const key = schemaCacheKey(target);
		set((s) => ({
			byKey: {
				...s.byKey,
				[key]: { status: "loading", schema: null, error: null, fetchedAt: null },
			},
		}));
		try {
			const schema = await introspectSchema(target);
			set((s) => ({
				byKey: {
					...s.byKey,
					[key]: { status: "ready", schema, error: null, fetchedAt: Date.now() },
				},
			}));
		} catch (e) {
			set((s) => ({
				byKey: {
					...s.byKey,
					[key]: {
						status: "error",
						schema: null,
						error: e instanceof Error ? e.message : String(e),
						fetchedAt: Date.now(),
					},
				},
			}));
		}
	},
}));
