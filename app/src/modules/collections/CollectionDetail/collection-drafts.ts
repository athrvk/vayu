/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each of the collection screen's draft editors edits, read from the
 * collection: one definition for the editor's `useEntityDraft` value and for
 * the stored draft its save context checks once the editor is gone (#3459).
 */

import { hashKey, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { StoredDraft } from "@/hooks/useDraftSaveContext";
import { queryKeys } from "@/queries/keys";
import { entityDraftKey } from "@/stores/entity-draft-store";
import type { Collection, ElementDef } from "@/types";

export interface CollectionDrafts {
	info: { name: string; description: string };
	auth: Collection["auth"];
	elements: ElementDef[];
}

export type CollectionDraftField = keyof CollectionDrafts;

const PERSISTED: { [F in CollectionDraftField]: (c: Collection) => CollectionDrafts[F] } = {
	info: (c) => ({ name: c.name, description: c.description ?? "" }),
	auth: (c) => c.auth,
	elements: (c) => c.elements,
};

/** The persisted value an editor of `field` drafts against. */
export function persistedDraft<F extends CollectionDraftField>(
	collection: Collection,
	field: F
): CollectionDrafts[F] {
	return PERSISTED[field](collection);
}

function storedCollectionDraft(
	queryClient: QueryClient,
	collectionId: string,
	field: CollectionDraftField
): StoredDraft {
	const listKey = queryKeys.collections.list();
	const listHash = hashKey(listKey);
	return {
		key: entityDraftKey(collectionId, field),
		read: () => {
			const collections = queryClient.getQueryData<Collection[]>(listKey);
			if (!collections) return undefined;
			const collection = collections.find((c) => c.id === collectionId);
			return collection ? { value: persistedDraft(collection, field) } : "gone";
		},
		subscribe: (onChange) =>
			queryClient.getQueryCache().subscribe((event) => {
				if (event.query.queryHash === listHash) onChange();
			}),
	};
}

/**
 * Where `field`'s draft of the collection is stored, read against the
 * collections list: the list every editor on the screen takes its collection
 * from, and the one a delete or an update elsewhere (MCP, another window)
 * lands in.
 */
export function useStoredCollectionDraft(
	collectionId: string,
	field: CollectionDraftField
): StoredDraft {
	return storedCollectionDraft(useQueryClient(), collectionId, field);
}
