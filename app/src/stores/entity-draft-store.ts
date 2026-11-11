/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Entity Draft Store
 *
 * The unsaved drafts of the manual save-button editors (`useEntityDraft`), by
 * entity key, so a draft outlives the editor that holds it (#3459). `Shell.tsx`
 * mounts only the tab on screen, so looking at a request unmounts the whole
 * collection screen; with the draft in component state that threw an unsaved
 * script away without a word.
 *
 * Clean is absence: an entry exists only while its draft differs from what the
 * editor last read as persisted. `baseline` is the persisted value the draft
 * diverged from, which is how a change that lands while the editor is away
 * still arrives as a conflict (`externalValue`) rather than as the draft.
 *
 * A key is `<entityId>:<field>` (`entityDraftKey`), so everything one
 * entity holds can be dropped together (`dropForEntities`): closing its tab or
 * deleting it throws the draft away. An entry's draft is opaque here; the key
 * decides its type, and `useEntityDraft` reads it back as the `T` it wrote.
 *
 * In memory only, never `persist`ed: a draft can carry a credential, and an
 * unsaved edit does not outlive the app - the quit flush saves it or asks.
 */

import { create } from "zustand";
import type { Collection } from "@/types";

export interface EntityDraftEntry<T = unknown> {
	draft: T;
	baseline: T;
}

interface EntityDraftState {
	entries: ReadonlyMap<string, EntityDraftEntry>;
	put: (key: string, entry: EntityDraftEntry) => void;
	/**
	 * Drops `key`. Given `only`, drops it only while that is still the entry, so
	 * a caller acting on what it read earlier cannot drop a newer edit.
	 */
	drop: (key: string, only?: EntityDraftEntry) => void;
	/** Drops every key belonging to these entities - a closed tab, a delete. */
	dropForEntities: (entityIds: Iterable<string>) => void;
}

/** The key one field of one entity is drafted under. `field` holds no colon. */
export const entityDraftKey = (entityId: string, field: string) => `${entityId}:${field}`;

const entityOf = (key: string) => key.slice(0, key.lastIndexOf(":"));

export const useEntityDraftStore = create<EntityDraftState>((set, get) => ({
	entries: new Map(),

	put: (key, entry) => {
		const entries = new Map(get().entries);
		entries.set(key, entry);
		set({ entries });
	},

	drop: (key, only) => {
		const current = get().entries.get(key);
		if (!current || (only && current !== only)) return;
		const entries = new Map(get().entries);
		entries.delete(key);
		set({ entries });
	},

	dropForEntities: (entityIds) => {
		const ids = new Set(entityIds);
		const entries = new Map(get().entries);
		for (const key of entries.keys()) {
			if (ids.has(entityOf(key))) entries.delete(key);
		}
		if (entries.size !== get().entries.size) set({ entries });
	},
}));

/** Where a collection's Auth tab keeps its draft. */
export const collectionAuthDraftKey = (collectionId: string) =>
	entityDraftKey(collectionId, "auth");

/**
 * The collection's unsaved Auth-tab draft, or undefined when it has none (#1483).
 *
 * The Inheritance Chain card and the context bar's `CollectionAuthSection`
 * read the stored collection, which says nothing about a mode picked and not
 * yet saved; this is what lets both describe the picker rather than contradict
 * it, whether or not the Auth tab is mounted.
 */
export function useCollectionAuthDraft(
	collectionId: string | undefined
): Collection["auth"] | undefined {
	return useEntityDraftStore((s) =>
		collectionId
			? (s.entries.get(collectionAuthDraftKey(collectionId))?.draft as
					Collection["auth"] | undefined)
			: undefined
	);
}

/** Back to no drafts. Tests only: in the app a draft goes with its save, its Reset or its tab. */
export function resetEntityDraftStoreForTests(): void {
	useEntityDraftStore.setState({ entries: new Map() });
}
