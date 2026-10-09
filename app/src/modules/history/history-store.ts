/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// History UI State Store
// Server state (runs) is now managed by TanStack Query

import { create } from "zustand";
import type { Run, RunOrigin } from "@/types";
import { mcpClientDisplayName } from "@/lib/mcp-client-names";

/**
 * The values are `Run["type"]` plus `"all"`, and `filterRuns` compares them to
 * `run.type` directly - so a run type the filter cannot name is a type the list
 * can only ever show under "All". `scenario` (a collection run) was exactly
 * that until the runner shipped.
 */
export type FilterType = "all" | Run["type"];
export type FilterStatus = "all" | "pending" | "running" | "completed" | "stopped" | "failed";
/** The origin Select's kinds: `RunOrigin["kind"]` minus `other`, which has no entry of its own. */
export type FilterOrigin = "all" | Exclude<RunOrigin["kind"], "other">;
type SortBy = "newest" | "oldest";

interface HistoryUIState {
	// UI-only state
	searchQuery: string;
	filterType: FilterType;
	filterStatus: FilterStatus;
	/**
	 * Show only pinned runs - of any type, not only load runs' comparison
	 * baselines. Server-side, like the search: it drives `GET
	 * /runs?baseline=true`, so a pin older than the pages the sidebar has
	 * loaded is still findable - which a client-side sieve over the loaded
	 * pages could not do, and finding pins is the whole point.
	 */
	pinnedOnly: boolean;
	/**
	 * Who started the run. The kind is applied on both sides, like `pinnedOnly`:
	 * `GET /runs?origin=` decides which runs are fetched (an agent's run older
	 * than the loaded pages is reachable) and `filterRuns` decides which fetched
	 * rows are shown.
	 */
	filterOrigin: FilterOrigin;
	/**
	 * Narrows `filterOrigin: "mcp"` to one client, held as the **display name**
	 * (`mcpClientDisplayName`) rather than the raw identifier: two spellings of
	 * one product (`claude-code`, `Claude Code`) are one entry in the Select,
	 * and a raw string would make that a choice between two identical labels.
	 * Client side only - the engine filters on kind, not on a client's name.
	 * `null` is every client.
	 */
	filterClient: string | null;
	sortBy: SortBy;

	// Actions
	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setPinnedOnly: (pinnedOnly: boolean) => void;
	setFilterOrigin: (origin: FilterOrigin) => void;
	setFilterClient: (client: string | null) => void;
	setSortBy: (sortBy: SortBy) => void;
	resetFilters: () => void;
}

export const useHistoryStore = create<HistoryUIState>((set) => ({
	searchQuery: "",
	filterType: "all",
	filterStatus: "all",
	pinnedOnly: false,
	filterOrigin: "all",
	filterClient: null,
	sortBy: "newest",

	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setPinnedOnly: (pinnedOnly) => set({ pinnedOnly }),
	// A client belongs to the kind it was picked under, so changing the kind
	// drops it: "Agents > Cursor" must not survive a switch to "App".
	setFilterOrigin: (origin) => set({ filterOrigin: origin, filterClient: null }),
	setFilterClient: (client) => set({ filterClient: client }),
	setSortBy: (sortBy) => set({ sortBy }),
	resetFilters: () =>
		set({
			searchQuery: "",
			filterType: "all",
			filterStatus: "all",
			pinnedOnly: false,
			filterOrigin: "all",
			filterClient: null,
			sortBy: "newest",
		}),
}));

/**
 * Filter (by type/status/pin/origin) and sort a run list. Search is *not* handled
 * here: it moved server-side to the `q` param so it covers all runs, not just
 * the pages loaded into the sidebar (see `useRunsQuery`). Only the MCP-client
 * narrowing and the sort are client-side alone, over the loaded pages.
 * Use with the flattened infinite-query data.
 *
 * Type, status, `pinnedOnly` and the origin kind are applied on *both* sides,
 * and deliberately: the `type=` / `status=` / `baseline=true` / `origin=`
 * params decide which runs are fetched, and this pass decides which of the
 * fetched rows are shown. Unpinning patches the loaded pages in place rather
 * than refetching them (`useSetRunBaselineMutation` - a refetch would lose a
 * pin the user scrolled to), so without this pass the run just unpinned would
 * sit in the pinned-only list until the next poll.
 */
export function filterRuns(
	runs: Run[],
	filters: Pick<
		HistoryUIState,
		"filterType" | "filterStatus" | "pinnedOnly" | "filterOrigin" | "filterClient" | "sortBy"
	>
): Run[] {
	const { filterType, filterStatus, pinnedOnly, filterOrigin, filterClient, sortBy } = filters;

	let filtered = runs;

	// Apply type filter
	if (filterType !== "all") {
		filtered = filtered.filter((run) => run.type === filterType);
	}

	// Apply status filter
	if (filterStatus !== "all") {
		filtered = filtered.filter((run) => run.status === filterStatus);
	}

	// Apply pinned filter
	if (pinnedOnly) {
		filtered = filtered.filter((run) => run.baseline === true);
	}

	// A run without an origin is `other` (an engine older than the field), so
	// it is shown under neither Select entry.
	if (filterOrigin !== "all") {
		filtered = filtered.filter((run) => run.origin?.kind === filterOrigin);
	}

	if (filterClient !== null) {
		filtered = filtered.filter(
			(run) => mcpClientDisplayName(run.origin?.client) === filterClient
		);
	}

	// Apply sorting (using startTime which is a number timestamp)
	filtered = [...filtered].sort((a, b) => {
		const dateA = a.startTime || 0;
		const dateB = b.startTime || 0;
		return sortBy === "newest" ? dateB - dateA : dateA - dateB;
	});

	return filtered;
}

/**
 * The client names the origin Select offers under "Agents": the display name of
 * every MCP run in `runs`, plus `selected` so a chosen client stays listed
 * after the runs that named it scroll out of the loaded pages. Sorted, one per
 * name - two raw spellings of one product are one entry.
 *
 * Read from the rows *before* `filterRuns` narrows them by client, or choosing
 * one client would shrink the list to that client alone and the others would
 * vanish from the Select.
 */
export function mcpClientNames(runs: Run[], selected: string | null): string[] {
	const names = new Set<string>();
	for (const run of runs) {
		if (run.origin?.kind === "mcp") names.add(mcpClientDisplayName(run.origin.client));
	}
	if (selected !== null) names.add(selected);
	return [...names].sort((a, b) => a.localeCompare(b));
}
