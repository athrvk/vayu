/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saved requests and collections, as palette results.
 *
 * The point of the whole feature: reaching a request today means opening the
 * collections drawer and expanding a tree, and a request four folders deep is
 * several clicks from anywhere.
 *
 * Both kinds open through the same `openTab` calls the tree uses (see
 * `useTreeCrud`'s `navigateToRequest` / `navigateToCollection`), so a request
 * opened from here is indistinguishable from one opened from the sidebar.
 *
 * Reads come straight from the cache `usePrefetchCollectionsAndRequests` warms
 * at startup, so opening the palette fetches nothing.
 */

import { useMemo } from "react";
import { Folder } from "lucide-react";
import { useTabsStore } from "@/stores";
import { useCollectionsQuery, useMultipleCollectionRequests, useRunsQuery } from "@/queries";
import { flattenRunPages } from "@/queries";
import type { Collection } from "@/types";
import type { PaletteItem } from "../types";

/**
 * "Payments / Auth" for a nested collection, "" for a root one.
 *
 * Built iteratively with a visited set rather than by recursion: `parentId`
 * comes off the wire, and a cycle in it would otherwise hang the renderer
 * rather than mislabel one row.
 */
function collectionPath(id: string, byId: Map<string, Collection>): string {
	const names: string[] = [];
	const seen = new Set<string>();
	let current = byId.get(id);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		names.unshift(current.name);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return names.join(" / ");
}

/** When each request was last sent, from the run history already in cache. */
function lastSentByRequest(runs: { requestId?: string | null; startTime: number }[]) {
	const latest = new Map<string, number>();
	for (const run of runs) {
		if (!run.requestId) continue;
		const previous = latest.get(run.requestId);
		if (previous === undefined || run.startTime > previous) {
			latest.set(run.requestId, run.startTime);
		}
	}
	return latest;
}

export function useEntityItems(): PaletteItem[] {
	const openTab = useTabsStore((s) => s.openTab);
	const { data: collections = [] } = useCollectionsQuery();
	const collectionIds = collections.map((c) => c.id);
	const { requestsByCollection } = useMultipleCollectionRequests(collectionIds);
	const { data: runsData } = useRunsQuery();

	// `runsData` is the query's own object and `collections` is stable while the
	// query is; the map rebuilds only when one of them actually changes.
	const lastSent = useMemo(() => lastSentByRequest(flattenRunPages(runsData)), [runsData]);
	const byId = useMemo(() => new Map(collections.map((c) => [c.id, c])), [collections]);

	const items: PaletteItem[] = [];

	for (const collection of collections) {
		const path = collectionPath(collection.id, byId);
		// Where it sits, not what it is called - a root collection has no parent
		// to state, so it gets no subtitle rather than an empty one.
		const parentPath = collection.parentId ? collectionPath(collection.parentId, byId) : "";
		items.push({
			id: `collection:${collection.id}`,
			kind: "collection",
			title: collection.name,
			...(parentPath ? { subtitle: parentPath } : {}),
			icon: Folder,
			perform: () => openTab({ type: "collection", entityId: collection.id }),
		});

		for (const request of requestsByCollection.get(collection.id) ?? []) {
			items.push({
				id: `request:${request.id}`,
				kind: "request",
				title: request.name,
				subtitle: path,
				// The URL finds a request whose name says nothing about it - and
				// it is a keyword rather than the subtitle because the collection
				// is what the eye needs to tell two "Get user"s apart.
				//
				// It is matched literally rather than fuzzily: a path is character
				// soup to a subsequence scorer, and this one line was the palette's
				// noise generator - almost any five-letter query found its letters
				// scattered through some URL, and that request then outranked the
				// setting the user was actually looking for.
				keywords: [request.method],
				substringKeywords: [request.url],
				method: request.method,
				...(lastSent.has(request.id) ? { recencyAt: lastSent.get(request.id) } : {}),
				perform: () => openTab({ type: "request", entityId: request.id }),
			});
		}
	}

	return items;
}
