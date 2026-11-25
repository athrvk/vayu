/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// History's UI state only; the runs themselves are TanStack Query server state.

import { create } from "zustand";
import type { Run, RunOrigin, StoredRunOutcome } from "@/types";
import { rowStoredOutcome } from "@/components/shared/run-outcome";
import { mcpClientDisplayName } from "@/lib/mcp-client-names";

/**
 * `Run["type"]` plus `"all"`, compared to `run.type` directly by `filterRuns`, so a run type
 * missing here can only ever be shown under "All".
 */
export type FilterType = "all" | Run["type"];
export type FilterStatus = "all" | "pending" | "running" | "completed" | "stopped" | "failed";
/** The origin Select's kinds: `RunOrigin["kind"]` minus `other`, which has no entry of its own. */
export type FilterOrigin = "all" | Exclude<RunOrigin["kind"], "other">;
/** The outcome Select's verdicts, in the engine's spelling (`GET /runs?outcome=`). */
export type FilterOutcome = "all" | StoredRunOutcome;
type SortBy = "newest" | "oldest";

interface HistoryUIState {
	searchQuery: string;
	filterType: FilterType;
	filterStatus: FilterStatus;
	/**
	 * Show only pinned runs, of any type (not only load runs' comparison baselines). Server-side
	 * like the search (`GET /runs?baseline=true`), so a pin older than the loaded pages is still
	 * findable, which a client-side sieve could not do.
	 */
	pinnedOnly: boolean;
	/**
	 * Who started the run. Applied on both sides like `pinnedOnly`: `GET /runs?origin=` decides
	 * which runs are fetched (an agent's run older than the loaded pages is reachable),
	 * `filterRuns` which fetched rows are shown.
	 */
	filterOrigin: FilterOrigin;
	/**
	 * The verdict the row draws, applied on both sides like `filterOrigin`: `GET /runs?outcome=`
	 * decides which runs are fetched (the engine stores the verdict, so an older failure is
	 * reachable), `filterRuns` which fetched rows are shown, from the stored outcome or the one
	 * `rowOutcome` derives for a row without one.
	 */
	filterOutcome: FilterOutcome;
	/**
	 * Narrows `filterOrigin: "mcp"` to one client, held as the **display name**
	 * (`mcpClientDisplayName`), not the raw identifier: two spellings of one product
	 * (`claude-code`, `Claude Code`) are one Select entry, not two identical labels. Client side
	 * only (the engine filters on kind, not on a client's name). `null` is every client.
	 */
	filterClient: string | null;
	sortBy: SortBy;

	setSearchQuery: (query: string) => void;
	setFilterType: (type: FilterType) => void;
	setFilterStatus: (status: FilterStatus) => void;
	setPinnedOnly: (pinnedOnly: boolean) => void;
	setFilterOrigin: (origin: FilterOrigin) => void;
	setFilterOutcome: (outcome: FilterOutcome) => void;
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
	filterOutcome: "all",
	filterClient: null,
	sortBy: "newest",

	setSearchQuery: (query) => set({ searchQuery: query }),
	setFilterType: (type) => set({ filterType: type }),
	setFilterStatus: (status) => set({ filterStatus: status }),
	setPinnedOnly: (pinnedOnly) => set({ pinnedOnly }),
	// A client belongs to the kind it was picked under, so changing the kind
	// drops it: "Agents > Cursor" must not survive a switch to "App".
	setFilterOrigin: (origin) => set({ filterOrigin: origin, filterClient: null }),
	setFilterOutcome: (outcome) => set({ filterOutcome: outcome }),
	setFilterClient: (client) => set({ filterClient: client }),
	setSortBy: (sortBy) => set({ sortBy }),
	resetFilters: () =>
		set({
			searchQuery: "",
			filterType: "all",
			filterStatus: "all",
			pinnedOnly: false,
			filterOrigin: "all",
			filterOutcome: "all",
			filterClient: null,
			sortBy: "newest",
		}),
}));

/**
 * Filter (type, status, pin, origin, outcome) and sort a run list, the flattened infinite-query
 * data. Search is not here: it is the server-side `q` param, so it covers every run, not only the
 * loaded pages (see `useRunsQuery`). Only the MCP-client narrowing and the sort are client side
 * alone, over the loaded pages.
 *
 * Type, status, `pinnedOnly`, the origin kind and the outcome are applied on *both* sides on
 * purpose: the `type=` / `status=` / `baseline=true` / `origin=` / `outcome=` params decide which
 * runs are fetched, this pass which fetched rows are shown. Unpinning patches the loaded pages in
 * place (`useSetRunBaselineMutation`; a refetch would lose a pin the user scrolled to), so without
 * this pass a run just unpinned would stay in the pinned-only list until the next poll.
 */
export function filterRuns(
	runs: Run[],
	filters: Pick<
		HistoryUIState,
		| "filterType"
		| "filterStatus"
		| "pinnedOnly"
		| "filterOrigin"
		| "filterOutcome"
		| "filterClient"
		| "sortBy"
	>
): Run[] {
	const {
		filterType,
		filterStatus,
		pinnedOnly,
		filterOrigin,
		filterOutcome,
		filterClient,
		sortBy,
	} = filters;

	let filtered = runs;

	if (filterType !== "all") {
		filtered = filtered.filter((run) => run.type === filterType);
	}

	if (filterStatus !== "all") {
		filtered = filtered.filter((run) => run.status === filterStatus);
	}

	if (pinnedOnly) {
		filtered = filtered.filter((run) => run.baseline === true);
	}

	// A run without an origin is `other` (an engine older than the field), so
	// it is shown under neither Select entry.
	if (filterOrigin !== "all") {
		filtered = filtered.filter((run) => run.origin?.kind === filterOrigin);
	}

	// A row the renderer draws no verdict for has no outcome, and matches none.
	if (filterOutcome !== "all") {
		filtered = filtered.filter((run) => rowStoredOutcome(run) === filterOutcome);
	}

	if (filterClient !== null) {
		filtered = filtered.filter(
			(run) => mcpClientDisplayName(run.origin?.client) === filterClient
		);
	}

	// `startTime` is a number (epoch ms); a run without one sorts as 0.
	filtered = [...filtered].sort((a, b) => {
		const dateA = a.startTime || 0;
		const dateB = b.startTime || 0;
		return sortBy === "newest" ? dateB - dateA : dateA - dateB;
	});

	return filtered;
}

/**
 * The client names the origin Select offers under "Agents": the display name of every MCP run in
 * `runs`, plus `selected`, so a chosen client stays listed after its runs scroll out of the loaded
 * pages. Sorted, one per name (two raw spellings of one product are one entry).
 *
 * Read from the rows *before* `filterRuns` narrows them by client, or choosing one client would
 * leave it the only entry in the Select.
 */
export function mcpClientNames(runs: Run[], selected: string | null): string[] {
	const names = new Set<string>();
	for (const run of runs) {
		if (run.origin?.kind === "mcp") names.add(mcpClientDisplayName(run.origin.client));
	}
	if (selected !== null) names.add(selected);
	return [...names].sort((a, b) => a.localeCompare(b));
}
