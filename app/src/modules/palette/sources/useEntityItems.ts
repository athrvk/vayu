/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saved requests and collections, as palette results: a request four folders deep is otherwise the
 * collections drawer and several clicks away.
 *
 * Both open through the `openTab` calls the tree uses (`useTreeCrud`'s `navigateToRequest` /
 * `navigateToCollection`), so a request opened here is indistinguishable from one opened from the
 * sidebar. Reads come from the cache `usePrefetchCollectionsAndRequests` warms at startup, so
 * opening the palette fetches nothing.
 */

import { useMemo } from "react";
import { Folder } from "lucide-react";
import { useTabsStore } from "@/stores";
import { useCollectionsQuery, useMultipleCollectionRequests, useRunsQuery } from "@/queries";
import { flattenRunPages } from "@/queries";
import { collectionPath } from "@/modules/collections/tree-utils";
import { requestTabTitle } from "@/lib/request-title";
import type { PaletteItem } from "../types";

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

	// The palette re-renders on every keystroke, so this build (every collection, every request in
	// it, a `collectionPath` walk per collection) is memoised, as `useRunItems`, `useSettingsItems`
	// and `useVariableItems` are (#1716). Keyed on the five values the loop reads: `runsData` stays
	// out of the deps (it is folded into `lastSent`), so the query's unrelated refetches do not
	// re-run it.
	return useMemo(() => {
		const result: PaletteItem[] = [];

		for (const collection of collections) {
			const path = collectionPath(collection.id, byId);
			// Where it sits, not what it is called - a root collection has no parent
			// to state, so it gets no subtitle rather than an empty one.
			const parentPath = collection.parentId ? collectionPath(collection.parentId, byId) : "";
			result.push({
				id: `collection:${collection.id}`,
				kind: "collection",
				title: collection.name,
				...(parentPath ? { subtitle: parentPath } : {}),
				icon: Folder,
				perform: () => openTab({ type: "collection", entityId: collection.id }),
			});

			for (const request of requestsByCollection.get(collection.id) ?? []) {
				result.push({
					id: `request:${request.id}`,
					kind: "request",
					// The name the request's tab shows, so an unnamed request reads as
					// its URL path rather than "New Request" (#3323).
					title: requestTabTitle(request.name, request.url),
					subtitle: path,
					// The URL finds a request whose name says nothing about it; a keyword, not the
					// subtitle, because the collection is what tells two "Get user"s apart. Matched
					// literally, not fuzzily: a path is character soup to a subsequence scorer, and
					// fuzzily almost any five-letter query found its letters scattered through some
					// URL and outranked the setting the user wanted.
					keywords: [request.method],
					substringKeywords: [request.url],
					method: request.method,
					entityKey: `request:${request.id}`,
					...(lastSent.has(request.id) ? { recencyAt: lastSent.get(request.id) } : {}),
					perform: () => openTab({ type: "request", entityId: request.id }),
				});
			}
		}

		return result;
	}, [collections, requestsByCollection, lastSent, byId, openTab]);
}
