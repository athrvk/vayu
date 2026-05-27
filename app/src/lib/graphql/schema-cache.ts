/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * In-memory GraphQL schema cache keyed by resolved endpoint URL. The request
 * builder sets the active URL and triggers ensureSchema; Monaco providers read
 * getActiveSchema(). One editor is visible at a time, so a single active URL is
 * sufficient.
 */

import { create } from "zustand";
import type { GraphQLSchema } from "graphql";
import { introspectSchema } from "./introspect";

export type SchemaStatus = "idle" | "loading" | "ready" | "error";

interface SchemaEntry {
	status: SchemaStatus;
	schema: GraphQLSchema | null;
	error: string | null;
	fetchedAt: number | null;
}

interface SchemaCacheState {
	byUrl: Record<string, SchemaEntry>;
	activeUrl: string | null;
	setActiveUrl: (url: string | null) => void;
	getActiveSchema: () => GraphQLSchema | null;
	getActiveStatus: () => SchemaStatus;
	/** Introspect only if this url has not been attempted yet. */
	ensureSchema: (url: string, headers: Record<string, string>) => Promise<void>;
	/** Force a re-introspection regardless of any cached result for this url. */
	refreshSchema: (url: string, headers: Record<string, string>) => Promise<void>;
}

export const useSchemaCache = create<SchemaCacheState>((set, get) => ({
	byUrl: {},
	activeUrl: null,

	setActiveUrl: (url) => set({ activeUrl: url }),

	getActiveSchema: () => {
		const { activeUrl, byUrl } = get();
		return activeUrl ? (byUrl[activeUrl]?.schema ?? null) : null;
	},

	getActiveStatus: () => {
		const { activeUrl, byUrl } = get();
		return activeUrl ? (byUrl[activeUrl]?.status ?? "idle") : "idle";
	},

	ensureSchema: async (url, headers) => {
		if (!url) return;
		const existing = get().byUrl[url];
		if (existing && existing.status !== "idle") return;
		await get().refreshSchema(url, headers);
	},

	refreshSchema: async (url, headers) => {
		if (!url) return;
		set((s) => ({
			byUrl: {
				...s.byUrl,
				[url]: { status: "loading", schema: null, error: null, fetchedAt: null },
			},
		}));
		try {
			const schema = await introspectSchema(url, headers);
			set((s) => ({
				byUrl: {
					...s.byUrl,
					[url]: { status: "ready", schema, error: null, fetchedAt: Date.now() },
				},
			}));
		} catch (e) {
			set((s) => ({
				byUrl: {
					...s.byUrl,
					[url]: {
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
