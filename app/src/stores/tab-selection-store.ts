/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tab Selection Store
 *
 * Remembers each surface's active sub-tab per entity id, so it survives:
 * - `Shell.tsx` unmounting the whole surface when its workspace tab is not
 *   the one on screen (one tab's surface is mounted at a time)
 * - Switching between two open request/collection tabs of the same type,
 *   which reuses the component instance rather than remounting it, exactly
 *   as `response-store.ts` does for response data
 *
 * In memory only, like `response-store.ts` - a sub-tab pick is not worth
 * persisting to disk. Unlike that store, this one carries no LRU cap: an
 * entry here is one enum value rather than a response body, so even a long
 * session's worth of distinct entities costs nothing worth bounding. Entries
 * are dropped only when their entity is (`clearEntity`, wired at the same
 * delete seams `response-store` uses).
 */

import { create } from "zustand";
import type { RequestTab, ResponseTab } from "@/modules/request-builder/types";
import type { CollectionTab } from "@/modules/collections/CollectionDetail";

interface TabSelectionState {
	requestTab: Map<string, RequestTab>;
	responseTab: Map<string, ResponseTab>;
	collectionTab: Map<string, CollectionTab>;

	getRequestTab: (id: string) => RequestTab | null;
	setRequestTab: (id: string, tab: RequestTab) => void;
	getResponseTab: (id: string) => ResponseTab | null;
	setResponseTab: (id: string, tab: ResponseTab) => void;
	getCollectionTab: (id: string) => CollectionTab | null;
	setCollectionTab: (id: string, tab: CollectionTab) => void;

	/** Drops `id` from all three maps - a deleted request or collection. */
	clearEntity: (id: string) => void;
	clearAll: () => void;
}

export const useTabSelectionStore = create<TabSelectionState>((set, get) => ({
	requestTab: new Map(),
	responseTab: new Map(),
	collectionTab: new Map(),

	getRequestTab: (id) => get().requestTab.get(id) ?? null,
	setRequestTab: (id, tab) => {
		const requestTab = new Map(get().requestTab);
		requestTab.set(id, tab);
		set({ requestTab });
	},

	getResponseTab: (id) => get().responseTab.get(id) ?? null,
	setResponseTab: (id, tab) => {
		const responseTab = new Map(get().responseTab);
		responseTab.set(id, tab);
		set({ responseTab });
	},

	getCollectionTab: (id) => get().collectionTab.get(id) ?? null,
	setCollectionTab: (id, tab) => {
		const collectionTab = new Map(get().collectionTab);
		collectionTab.set(id, tab);
		set({ collectionTab });
	},

	clearEntity: (id) => {
		const { requestTab, responseTab, collectionTab } = get();
		if (!requestTab.has(id) && !responseTab.has(id) && !collectionTab.has(id)) return;
		const nextRequestTab = new Map(requestTab);
		nextRequestTab.delete(id);
		const nextResponseTab = new Map(responseTab);
		nextResponseTab.delete(id);
		const nextCollectionTab = new Map(collectionTab);
		nextCollectionTab.delete(id);
		set({
			requestTab: nextRequestTab,
			responseTab: nextResponseTab,
			collectionTab: nextCollectionTab,
		});
	},

	clearAll: () => {
		set({ requestTab: new Map(), responseTab: new Map(), collectionTab: new Map() });
	},
}));
