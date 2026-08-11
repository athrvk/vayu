/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// History UI State Store
// Server state (runs) is now managed by TanStack Query

import { create } from "zustand";
import type { Run } from "@/types";

/**
 * The values are `Run["type"]` plus `"all"`, and `filterRuns` compares them to
 * `run.type` directly - so a run type the filter cannot name is a type the list
 * can only ever show under "All". `scenario` (a collection run) was exactly
 * that until the runner shipped.
 */
export type FilterType = "all" | Run["type"];
export type FilterStatus = "all" | "pending" | "running" | "completed" | "stopped" | "failed";
type SortBy = "newest" | "oldest";

interface HistoryUIState {
	// UI-only state
	searchQuery: string;
	filterType: FilterType;
	filterStatus: FilterStatus;
	/**
	 * Show only runs pinned as a baseline. Server-side, like the search: it
	 * drives `GET /runs?baseline=true`, so a pin older than the pages the
	 * sidebar has loaded is still findable - which a client-side sieve over the
	 * loaded pages could not do, and finding pins is the whole point.
	 */
	pinnedOnly: boolean;
	sortBy: SortBy;

	// Actions
	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setPinnedOnly: (pinnedOnly: boolean) => void;
	setSortBy: (sortBy: SortBy) => void;
	resetFilters: () => void;
}

export const useHistoryStore = create<HistoryUIState>((set) => ({
	searchQuery: "",
	filterType: "all",
	filterStatus: "all",
	pinnedOnly: false,
	sortBy: "newest",

	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setPinnedOnly: (pinnedOnly) => set({ pinnedOnly }),
	setSortBy: (sortBy) => set({ sortBy }),
	resetFilters: () =>
		set({
			searchQuery: "",
			filterType: "all",
			filterStatus: "all",
			pinnedOnly: false,
			sortBy: "newest",
		}),
}));

/**
 * Filter (by type/status/pin) and sort a run list. Search is *not* handled
 * here: it moved server-side to the `q` param so it covers all runs, not just
 * the pages loaded into the sidebar (see `useRunsQuery`). Type/status/sort stay
 * client-side, applied over the currently loaded pages.
 * Use with the flattened infinite-query data.
 *
 * `pinnedOnly` is the one filter applied on *both* sides, and deliberately: the
 * `baseline=true` param decides which runs are fetched, and this pass decides
 * which of the fetched rows are shown. Unpinning patches the loaded pages in
 * place rather than refetching them (`useSetRunBaselineMutation` - a refetch
 * would lose a pin the user scrolled to), so without this pass the run just
 * unpinned would sit in the pinned-only list until the next poll.
 */
export function filterRuns(
	runs: Run[],
	filters: Pick<HistoryUIState, "filterType" | "filterStatus" | "pinnedOnly" | "sortBy">
): Run[] {
	const { filterType, filterStatus, pinnedOnly, sortBy } = filters;

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

	// Apply sorting (using startTime which is a number timestamp)
	filtered = [...filtered].sort((a, b) => {
		const dateA = a.startTime || 0;
		const dateB = b.startTime || 0;
		return sortBy === "newest" ? dateB - dateA : dateA - dateB;
	});

	return filtered;
}
