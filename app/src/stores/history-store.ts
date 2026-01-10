// History State Store

import { create } from "zustand";
import type { Run } from "@/types";

type FilterType = "all" | "load" | "sanity";
type FilterStatus = "all" | "running" | "completed" | "failed";
type SortBy = "newest" | "oldest";

interface HistoryState {
	runs: Run[];
	isLoading: boolean;
	error: string | null;
	searchQuery: string;
	filterType: FilterType;
	filterStatus: FilterStatus;
	sortBy: SortBy;
	totalCount: number;

	// Actions
	setRuns: (runs: Run[]) => void;
	addRun: (run: Run) => void;
	updateRun: (run: Run) => void;
	removeRun: (runId: string) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setSortBy: (sortBy: SortBy) => void;
	setTotalCount: (count: number) => void;

	// Helpers
	getFilteredRuns: () => Run[];
	getRunById: (runId: string) => Run | undefined;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
	runs: [],
	isLoading: false,
	error: null,
	searchQuery: "",
	filterType: "all",
	filterStatus: "all",
	sortBy: "newest",
	totalCount: 0,

	setRuns: (runs) => set({ runs }),

	addRun: (run) =>
		set((state) => ({
			runs: [run, ...state.runs],
			totalCount: state.totalCount + 1,
		})),

	updateRun: (run) =>
		set((state) => ({
			runs: state.runs.map((r) => (r.id === run.id ? run : r)),
		})),

	removeRun: (runId) =>
		set((state) => ({
			runs: state.runs.filter((r) => r.id !== runId),
			totalCount: Math.max(0, state.totalCount - 1),
		})),

	setLoading: (loading) => set({ isLoading: loading }),
	setError: (error) => set({ error }),
	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setSortBy: (sortBy) => set({ sortBy }),
	setTotalCount: (count) => set({ totalCount: count }),

	// Helpers
	getFilteredRuns: () => {
		const { runs, searchQuery, filterType, filterStatus, sortBy } = get();

		let filtered = runs;

		// Apply search filter
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(run) =>
					run.id.toLowerCase().includes(query) ||
					run.request_id.toLowerCase().includes(query)
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

		// Apply sorting
		filtered = [...filtered].sort((a, b) => {
			const dateA = new Date(a.started_at).getTime();
			const dateB = new Date(b.started_at).getTime();
			return sortBy === "newest" ? dateB - dateA : dateA - dateB;
		});

		return filtered;
	},

	getRunById: (runId) => {
		return get().runs.find((r) => r.id === runId);
	},
}));
