/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The spec-file and data-file bindings between the engine row and the two
 * stores that mirror them (#2765).
 *
 * The row is the record: `Collection.specFile` / `Collection.dataFile`, so a
 * backup carries them and a trashed collection keeps them. The stores are a
 * by-id view of the collections list, rebuilt from it here on every write to
 * its cache. That is why nothing clears a binding on delete or re-applies one
 * on restore: the row leaves the list and its entry goes, the row comes back
 * and so does the entry.
 */

import type { QueryClient } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";

import { apiService } from "@/services/api";
import { DATA_FILE_HASH_PATTERN } from "@/services/data-files/hash";
import { logError } from "@/errors/error-logger";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { useDataFileStore } from "@/stores/data-file-store";
import { useSpecFileStore } from "@/stores/spec-file-store";
import type { Collection, UpdateCollectionRequest } from "@/types";
import { storeUpdatedCollection } from "./collections";
import { queryKeys } from "./keys";

/** Whether two locations name the same file the same way, member by member. */
function sameLocation<T extends object>(a: T, b: T): boolean {
	const keys = Object.keys(a) as (keyof T)[];
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The bindings @p pick reads off @p collections, keyed by id - reusing
 * @p previous whole when nothing changed, and each unchanged entry otherwise.
 * Identity is what readers key on: `useDataFileLocationMirror` republishes to
 * the main process on a new map, and a selector's entry is an effect's input.
 */
function mirrorOf<T extends object>(
	previous: Record<string, T>,
	collections: readonly Collection[],
	pick: (collection: Collection) => T | undefined
): Record<string, T> {
	const next: Record<string, T> = {};
	let changed = false;
	for (const collection of collections) {
		const location = pick(collection);
		if (!location) continue;
		const before = previous[collection.id];
		const same = before !== undefined && sameLocation(before, location);
		next[collection.id] = same ? before : location;
		changed ||= !same;
	}
	if (!changed && Object.keys(next).length === Object.keys(previous).length) return previous;
	return next;
}

/** Rebuild both stores from the collections list. */
export function mirrorFileBindings(collections: readonly Collection[]): void {
	const specFiles = useSpecFileStore.getState().locations;
	const nextSpecFiles = mirrorOf(specFiles, collections, (c) => c.specFile);
	if (nextSpecFiles !== specFiles) useSpecFileStore.setState({ locations: nextSpecFiles });

	const dataFiles = useDataFileStore.getState().locations;
	const nextDataFiles = mirrorOf(dataFiles, collections, (c) => c.dataFile);
	if (nextDataFiles !== dataFiles) useDataFileStore.setState({ locations: nextDataFiles });
}

/**
 * Mirror @p queryClient's collections list into the stores now and on every
 * write to it, and answer the unsubscribe.
 *
 * A cache listener rather than an effect on the query's data: the cache
 * notifies its listeners synchronously inside the write, before any observer
 * re-renders, so a component that reads a collection off the list and its
 * binding off a store (the Run dialogs' pre-fill reads the contract one way
 * and the file the other) never renders the one without the other.
 */
export function installFileBindingMirror(queryClient: QueryClient): () => void {
	const listHash = hashKey(queryKeys.collections.list());
	let mirrored: Collection[] | undefined;
	const sync = () => {
		const collections = queryClient.getQueryData<Collection[]>(queryKeys.collections.list());
		if (collections === undefined || collections === mirrored) return;
		mirrored = collections;
		mirrorFileBindings(collections);
	};
	sync();
	return queryClient.getQueryCache().subscribe((event) => {
		if (event.query.queryHash === listHash) sync();
	});
}

/** A collection update that carries a file binding and nothing else. */
export type FileBindingUpdate = Pick<UpdateCollectionRequest, "id" | "specFile" | "dataFile">;

/**
 * Write a binding outside a mutation hook - a re-read's hash, the one-time
 * import - and put the answered row in @p queryClient's list, which is what
 * reaches the stores. Rejects with the engine's error; the caller decides
 * whether a failure is the user's to see.
 */
export async function writeFileBinding(
	queryClient: QueryClient,
	update: FileBindingUpdate
): Promise<Collection> {
	const updated = await apiService.updateCollection(update);
	storeUpdatedCollection(queryClient, updated);
	return updated;
}

/**
 * A read of `path` answered `hash` (#2051): every binding at that path takes
 * it. Keyed by path rather than collection because a read is of a path, and a
 * file whose bytes changed changed for every collection bound to it.
 *
 * Written only where the hash moved, so re-reading an unchanged file writes
 * nothing. A failed write is logged, not shown: the read it rode on
 * succeeded, and the next read of the file tries again.
 */
export function recordDataFileHash(
	path: string,
	hash: string,
	queryClient: QueryClient = appQueryClient
): void {
	if (!DATA_FILE_HASH_PATTERN.test(hash)) return;
	for (const [id, location] of Object.entries(useDataFileStore.getState().locations)) {
		if (location.path !== path || location.hash === hash) continue;
		writeFileBinding(queryClient, { id, dataFile: { ...location, hash } }).catch(
			(error: unknown) =>
				logError(error instanceof Error ? error : new Error(String(error)), "low", {
					component: "renderer",
					action: "record-data-file-hash",
				})
		);
	}
}
