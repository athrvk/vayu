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

type FilterType = "all" | "load" | "design";
type FilterStatus = "all" | "pending" | "running" | "completed" | "stopped" | "failed";
type SortBy = "newest" | "oldest";

interface HistoryUIState {
	// UI-only state
	searchQuery: string;
	filterType: FilterType;
	filterStatus: FilterStatus;
	sortBy: SortBy;

	// Actions
	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setSortBy: (sortBy: SortBy) => void;
	resetFilters: () => void;
}

export const useHistoryStore = create<HistoryUIState>((set) => ({
	searchQuery: "",
	filterType: "all",
	filterStatus: "all",
	sortBy: "newest",

	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setSortBy: (sortBy) => set({ sortBy }),
	resetFilters: () =>
		set({
			searchQuery: "",
			filterType: "all",
			filterStatus: "all",
			sortBy: "newest",
		}),
}));

/**
 * Filter (by type/status) and sort a run list. Search is *not* handled here:
 * it moved server-side to the `q` param so it covers all runs, not just the
 * pages loaded into the sidebar (see `useRunsQuery`). Type/status/sort stay
 * client-side, applied over the currently loaded pages.
 * Use with the flattened infinite-query data.
 */
export function filterRuns(
	runs: Run[],
	filters: Pick<HistoryUIState, "filterType" | "filterStatus" | "sortBy">
): Run[] {
	const { filterType, filterStatus, sortBy } = filters;

	let filtered = runs;

	// Apply type filter
	if (filterType !== "all") {
		filtered = filtered.filter((run) => run.type === filterType);
	}

	// Apply status filter
	if (filterStatus !== "all") {
		filtered = filtered.filter((run) => run.status === filterStatus);
	}

	// Apply sorting (using startTime which is a number timestamp)
	filtered = [...filtered].sort((a, b) => {
		const dateA = a.startTime || 0;
		const dateB = b.startTime || 0;
		return sortBy === "newest" ? dateB - dateA : dateA - dateB;
	});

	return filtered;
}
