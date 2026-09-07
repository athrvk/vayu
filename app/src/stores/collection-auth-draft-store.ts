/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Mirrors a collection's Auth tab draft outside the tab itself (#1483).
 *
 * `AuthTab`'s draft is component-local state (`useEntityDraft`), invisible to
 * anything that is not `AuthTab` - including the Inheritance Chain card, which
 * it renders as a child, and the context bar's `CollectionAuthSection`, which
 * is mounted in a different part of the tree and reads `useCollectionsQuery`
 * directly. Both used to describe the last-saved auth while the picker sat on
 * an unsaved one, contradicting the form above them. `AuthTab` publishes its
 * live draft here while mounted; both readers fall back to the persisted value
 * once nothing is open for that collection.
 */

import { create } from "zustand";
import type { Collection } from "@/types";

interface CollectionAuthDraftState {
	drafts: Map<string, Collection["auth"]>;
	setDraft: (collectionId: string, auth: Collection["auth"]) => void;
	clearDraft: (collectionId: string) => void;
}

export const useCollectionAuthDraftStore = create<CollectionAuthDraftState>((set) => ({
	drafts: new Map(),
	setDraft: (collectionId, auth) =>
		set((s) => {
			const drafts = new Map(s.drafts);
			drafts.set(collectionId, auth);
			return { drafts };
		}),
	clearDraft: (collectionId) =>
		set((s) => {
			if (!s.drafts.has(collectionId)) return s;
			const drafts = new Map(s.drafts);
			drafts.delete(collectionId);
			return { drafts };
		}),
}));

/** The collection's live Auth-tab draft, or undefined when no tab is open. */
export function useCollectionAuthDraft(
	collectionId: string | undefined
): Collection["auth"] | undefined {
	return useCollectionAuthDraftStore((s) =>
		collectionId ? s.drafts.get(collectionId) : undefined
	);
}
