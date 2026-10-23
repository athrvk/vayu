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
import type { Collection, DataFileLocation, UpdateCollectionRequest } from "@/types";
import { compareTreeOrder } from "@/types";
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

/**
 * Put a row the engine answered for a write into the collections list, in tree
 * order: the one cache write through which a binding reaches the stores. The
 * collection update hook stores every other answer through it too.
 */
export function storeUpdatedCollection(queryClient: QueryClient, updated: Collection): void {
	queryClient.setQueryData<Collection[]>(queryKeys.collections.list(), (old) => {
		const next = old?.map((c) => (c.id === updated.id ? updated : c)) ?? [];
		return next.sort(compareTreeOrder);
	});
}

/** A collection update that carries a file binding and nothing else. */
export type FileBindingUpdate = Pick<UpdateCollectionRequest, "id" | "specFile" | "dataFile">;

/** Whether @p update writes a spec-file or data-file binding. */
export function carriesFileBinding(update: UpdateCollectionRequest): boolean {
	return "specFile" in update || "dataFile" in update;
}

/**
 * Each collection's last binding write, settled either way. The engine replaces
 * a binding object whole, so two writes in flight land in whichever order it
 * answers them, and a write built from the binding before an earlier one landed
 * puts the earlier binding back.
 */
const bindingWriteTails = new Map<string, Promise<void>>();

/** Run @p send once collection @p id's earlier binding writes have landed and been stored. */
function afterEarlierBindingWrites<T>(id: string, send: () => Promise<T>): Promise<T> {
	const result = (bindingWriteTails.get(id) ?? Promise.resolve()).then(send);
	const tail = result.then(
		() => undefined,
		() => undefined
	);
	bindingWriteTails.set(id, tail);
	void tail.then(() => {
		if (bindingWriteTails.get(id) === tail) bindingWriteTails.delete(id);
	});
	return result;
}

async function sendAndStore(
	queryClient: QueryClient,
	update: UpdateCollectionRequest
): Promise<Collection> {
	const updated = await apiService.updateCollection(update);
	storeUpdatedCollection(queryClient, updated);
	return updated;
}

/**
 * Write a collection update that carries a binding - a pick, a Remove, the
 * one-time import - after that collection's earlier binding writes, and put
 * the answered row in @p queryClient's list, which is what reaches the stores.
 * Rejects with the engine's error; the caller decides whether a failure is the
 * user's to see.
 */
export function writeFileBinding(
	queryClient: QueryClient,
	update: UpdateCollectionRequest
): Promise<Collection> {
	return afterEarlierBindingWrites(update.id, () => sendAndStore(queryClient, update));
}

/**
 * Rewrite collection @p id's data-file binding as @p revise answers it, built
 * from the binding as it stands once every earlier binding write has landed -
 * never from the one a caller saw before sending. Answers `undefined`, and
 * sends nothing, when there is no binding then or @p revise answers
 * `undefined` for it (the binding moved to another file, or already says it).
 * The binding is read off the store, so @p queryClient is the client
 * {@link installFileBindingMirror} follows, as it is in the app.
 */
export function reviseDataFileBinding(
	queryClient: QueryClient,
	id: string,
	revise: (bound: DataFileLocation) => DataFileLocation | undefined
): Promise<Collection | undefined> {
	return afterEarlierBindingWrites(id, async () => {
		const bound = useDataFileStore.getState().locations[id];
		const dataFile = bound && revise(bound);
		return dataFile ? sendAndStore(queryClient, { id, dataFile }) : undefined;
	});
}

/** A change of how collection `id`'s bound file at `path` is read (#2540). */
export interface DataFileReading {
	id: string;
	path: string;
	castNumbers: boolean;
}

/**
 * Write @p reading's `castNumbers` onto the binding, only while it still
 * names that file and reads it otherwise: a toggle on a file the binding no
 * longer holds (its declare failed, or it had no path) must not re-describe
 * the file that is bound. Built from the binding at send time, so a hash
 * write that landed first is kept rather than put back.
 */
export function rememberDataFileReading(
	queryClient: QueryClient,
	{ id, path, castNumbers }: DataFileReading
): Promise<Collection | undefined> {
	return reviseDataFileBinding(queryClient, id, (bound) =>
		readsDifferently(bound, path, castNumbers) ? { ...bound, castNumbers } : undefined
	);
}

/** Whether @p bound names the file at @p path and reads it other than @p castNumbers says. */
export function readsDifferently(
	bound: DataFileLocation | undefined,
	path: string,
	castNumbers: boolean
): boolean {
	return bound?.path === path && (bound.castNumbers ?? false) !== castNumbers;
}

/**
 * A read of `path` answered `hash` (#2051): every binding at that path takes
 * it. Keyed by path rather than collection because a read is of a path, and a
 * file whose bytes changed changed for every collection bound to it.
 *
 * Written only where the hash moved, so re-reading an unchanged file writes
 * nothing, and only while the binding still names `path` when the write is
 * sent: a pick that landed first named another file. A failed write is
 * logged, not shown: the read it rode on succeeded, and the next read of the
 * file tries again.
 */
export function recordDataFileHash(
	path: string,
	hash: string,
	queryClient: QueryClient = appQueryClient
): void {
	if (!DATA_FILE_HASH_PATTERN.test(hash)) return;
	const measures = (bound: DataFileLocation) => bound.path === path && bound.hash !== hash;
	for (const [id, location] of Object.entries(useDataFileStore.getState().locations)) {
		if (!measures(location)) continue;
		reviseDataFileBinding(queryClient, id, (bound) =>
			measures(bound) ? { ...bound, hash } : undefined
		).catch((error: unknown) =>
			logError(error instanceof Error ? error : new Error(String(error)), "low", {
				component: "renderer",
				action: "record-data-file-hash",
			})
		);
	}
}
