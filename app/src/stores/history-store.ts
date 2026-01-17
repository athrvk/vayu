
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
	isDeletingRun: boolean;

	// Actions
	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setSortBy: (sortBy: SortBy) => void;
	setDeletingRun: (deleting: boolean) => void;
	resetFilters: () => void;
}

export const useHistoryStore = create<HistoryUIState>((set) => ({
	searchQuery: "",
	filterType: "all",
	filterStatus: "all",
	sortBy: "newest",
	isDeletingRun: false,

	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setSortBy: (sortBy) => set({ sortBy }),
	setDeletingRun: (deleting) => set({ isDeletingRun: deleting }),
	resetFilters: () =>
		set({
			searchQuery: "",
			filterType: "all",
			filterStatus: "all",
			sortBy: "newest",
		}),
}));

/**
 * Helper function to filter and sort runs
 * Use with TanStack Query data: filterRuns(runsQuery.data ?? [], store)
 */
export function filterRuns(
	runs: Run[],
	filters: Pick<HistoryUIState, "searchQuery" | "filterType" | "filterStatus" | "sortBy">
): Run[] {
	const { searchQuery, filterType, filterStatus, sortBy } = filters;

	let filtered = runs;

	// Apply search filter
	if (searchQuery.trim()) {
		const query = searchQuery.toLowerCase();
		filtered = filtered.filter(
			(run) =>
				run.id.toLowerCase().includes(query) ||
				(run.requestId && run.requestId.toLowerCase().includes(query)) ||
				run.configSnapshot?.request?.url?.toLowerCase().includes(query) ||
				run.configSnapshot?.url?.toLowerCase().includes(query)
		);
	}

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
