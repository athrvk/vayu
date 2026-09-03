/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Past runs, as palette results.
 *
 * The only server-backed source. The others read caches the app has already
 * warmed; the run archive has no bound and lives in the engine's database, so
 * this one asks - `GET /runs?q=`, the same server-side substring filter the
 * History sidebar's search box drives, capped to one small page.
 *
 * Three consequences the other sources do not have:
 *
 * - **The query is debounced.** A keystroke is not a search. Without this every
 *   character of "checkout" is its own request, and seven of the eight answers
 *   are thrown away.
 * - **An engine that is down hides the group, silently.** Typing is idle input,
 *   and a toast fired by idle input is the palette shouting at someone who did
 *   not ask it anything. The query does not retry either - a typist should not
 *   wait out a retry budget for a group that is about to disappear.
 * - **Nothing re-judges these rows.** The engine matched against the whole
 *   stored snapshot, which includes text no row prints, so a second opinion
 *   formed from the row alone would drop matches that are real. Each row says
 *   so with `preMatched`, and `ranking.ts` takes it at its word. The query
 *   itself used to be stuffed into the keywords to the same end, which worked
 *   by making every run score as an exact match - and outrank everything else.
 */

/* global setTimeout, clearTimeout */

import { useEffect, useMemo, useState } from "react";
import { Clock, FolderTree, Search, Zap } from "lucide-react";
import { useLayoutStore, useTabsStore } from "@/stores";
import { useCollectionsQuery, useRunSearchQuery } from "@/queries";
import { useHistoryStore } from "@/modules/history/history-store";
import { RUN_KIND_LABEL } from "@/modules/history/types";
import { formatRelativeTime } from "@/utils";
import type { Collection, Run } from "@/types";
import { type PaletteItem } from "../types";

/**
 * How long typing has to stop before the palette asks the engine. Matches the
 * History sidebar's own search debounce - one search box behaviour, two boxes.
 */
export const RUN_SEARCH_DEBOUNCE_MS = 300;

/** Open a run's tab - the same call the History sidebar's rows make. */
function openRunTab(runId: string): void {
	useTabsStore.getState().openTab({ type: "run", entityId: runId });
}

/** What the row reads as: the target, or the collection for a run that has none. */
function runTitle(run: Run, collectionsById: Map<string, Collection>): string {
	const scenario = run.summary?.scenario;
	if (scenario) {
		// The name while the collection is still there, the id when it is not -
		// the same fallback ladder `RunItem` walks, and never a blank row.
		const name = scenario.collectionId
			? (collectionsById.get(scenario.collectionId)?.name ?? scenario.collectionId)
			: undefined;
		return name ?? "Collection run";
	}
	const url = run.summary?.url;
	return url ?? RUN_KIND_LABEL[run.type];
}

export function useRunItems(query: string): PaletteItem[] {
	const trimmed = query.trim();
	const [debounced, setDebounced] = useState("");

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(trimmed), RUN_SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [trimmed]);

	// Clearing the box empties the group at once rather than 300ms later: the
	// debounce exists to spare the engine requests, not to leave stale rows on
	// screen under a query that no longer asks for them.
	const search = trimmed === "" ? "" : debounced;
	const { data, isError } = useRunSearchQuery(search);
	const { data: collections = [] } = useCollectionsQuery();

	const collectionsById = useMemo(
		() => new Map(collections.map((collection) => [collection.id, collection])),
		[collections]
	);

	return useMemo(() => {
		if (search === "" || isError || !data) return [];

		const items: PaletteItem[] = data.data.map((run) => ({
			id: `run:${run.id}`,
			kind: "run" as const,
			// The engine matched this run, against stored snapshot text no row
			// prints - see `PaletteItem.preMatched`.
			preMatched: true,
			title: runTitle(run, collectionsById),
			subtitle: `${RUN_KIND_LABEL[run.type]} · ${run.status} · ${formatRelativeTime(run.startTime)}`,
			// The query itself used to be first in this list, so cmdk's second
			// filter could not drop a row the engine had matched on snapshot
			// text no row prints. That is `ranking.ts`'s job now, and carrying
			// the query was never free: a row whose keywords contain the query
			// verbatim scores near 1, so every run outranked every real match.
			keywords: [run.summary?.method ?? "", run.type, run.status],
			icon: run.type === "load" ? Zap : run.summary?.scenario ? FolderTree : Clock,
			...(run.summary?.method ? { method: run.summary.method } : {}),
			recencyAt: run.startTime,
			perform: () => openRunTab(run.id),
		}));

		// Only when the page did not hold everything - see `useSettingsItems`.
		if (data.pagination.total > data.data.length) {
			items.push({
				id: "run:search-more",
				kind: "run" as const,
				title: `Search runs for “${search}”…`,
				subtitle: `${data.pagination.total} runs`,
				icon: Search,
				escape: true,
				perform: () => {
					const history = useHistoryStore.getState();
					// Reset first: type, status and pin filters are applied over
					// the fetched rows, so a filter left from an earlier visit
					// could hide the very run this row just promised to show.
					history.resetFilters();
					history.setSearchQuery(search);
					useLayoutStore.getState().setDrawerOpen(true);
					useLayoutStore.getState().setDrawerView("history");
				},
			});
		}

		return items;
	}, [search, isError, data, collectionsById]);
}
