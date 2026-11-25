/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useDrawerItemOpened } from "@/components/layout/drawer-item-opened";
import { formatNumber } from "@/lib/format-number";
import { useRunLiveness } from "@/hooks/useRunLiveness";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Clock, Pin } from "lucide-react";
import { useTabsStore, useLayoutStore, useToastStore } from "@/stores";
import { ApiError } from "@/services";
import {
	useHistoryStore,
	filterRuns,
	mcpClientNames,
	type FilterOrigin,
	type FilterOutcome,
	type FilterStatus,
	type FilterType,
} from "@/modules/history/history-store";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import {
	useRunsQuery,
	useDeleteRunMutation,
	useSetRunBaselineMutation,
	flattenRunPages,
	runsTotal,
	useCollectionsQuery,
} from "@/queries";
import {
	DrawerPanel,
	EmptyState,
	ErrorState,
	TruncatedText,
	ListSkeleton,
} from "@/components/shared";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	DeleteConfirmDialog,
	ICON_MOTION,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import RunItem from "./RunItem";
import { groupRunsByDay } from "./group-runs-by-day";
import { useHistoryListFocus } from "./useHistoryListFocus";
import type { Run } from "@/types";
import { Eyebrow } from "@/components/ui/eyebrow";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";

/**
 * The origin Select's one value for two store fields: a kind, or one agent client under it. A
 * client's value is this prefix plus its display name, which no kind spelling can collide with.
 */
const CLIENT_VALUE_PREFIX = "client:";

/**
 * The engine stops a live run before deleting it, and refuses the delete with a 409 if the run's
 * worker has not finished writing within its wait (deleting rows under a live writer orphans
 * metrics against a deleted run id). Nothing is removed then, so the user is told to try again
 * shortly, in words kept here as an instruction rather than the engine's wait-timed-out phrasing.
 */
function deleteRunErrorMessage(error: unknown): string {
	if (error instanceof ApiError && error.statusCode === 409) {
		return "Couldn't delete this run yet - it's still stopping. Try again in a moment.";
	}
	return error instanceof Error ? `Couldn't delete run: ${error.message}` : "Couldn't delete run";
}

export default function HistoryList() {
	const openTab = useTabsStore((s) => s.openTab);
	const openRunComparison = useTabsStore((s) => s.openRunComparison);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const closeTabsForEntities = useTabsStore((s) => s.closeTabsForEntities);
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);
	const searchQuery = useHistoryStore((s) => s.searchQuery);
	const setSearchQuery = useHistoryStore((s) => s.setSearchQuery);
	const filterType = useHistoryStore((s) => s.filterType);
	const setFilterType = useHistoryStore((s) => s.setFilterType);
	const filterStatus = useHistoryStore((s) => s.filterStatus);
	const setFilterStatus = useHistoryStore((s) => s.setFilterStatus);
	const pinnedOnly = useHistoryStore((s) => s.pinnedOnly);
	const setPinnedOnly = useHistoryStore((s) => s.setPinnedOnly);
	const filterOrigin = useHistoryStore((s) => s.filterOrigin);
	const setFilterOrigin = useHistoryStore((s) => s.setFilterOrigin);
	const filterOutcome = useHistoryStore((s) => s.filterOutcome);
	const setFilterOutcome = useHistoryStore((s) => s.setFilterOutcome);
	const filterClient = useHistoryStore((s) => s.filterClient);
	const setFilterClient = useHistoryStore((s) => s.setFilterClient);
	const sortBy = useHistoryStore((s) => s.sortBy);
	const setSortBy = useHistoryStore((s) => s.setSortBy);

	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRunId = activeTab?.type === "run" ? activeTab.entityId : null;

	// The row-handler props below are stable on purpose: `RunItem` is memoised, and
	// one fresh function per render would make every row re-render anyway.
	const onItemOpened = useDrawerItemOpened();
	const navigateToRunDetail = useCallback(
		(runId: string) => {
			openTab({ type: "run", entityId: runId });
			onItemOpened();
		},
		[openTab, onItemOpened]
	);
	const navigateToHistory = () => activateDrawerView("history");

	// Debounce the search box into the server-side `q` param so a search covers
	// all runs (not just loaded pages) without a request per keystroke.
	const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);
	useEffect(() => {
		const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
		return () => clearTimeout(t);
	}, [searchQuery]);

	// Infinite runs query over the paginated envelope; polls the first page.
	const {
		data,
		isLoading,
		isError,
		error,
		refetch,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useRunsQuery(
		debouncedSearch,
		pinnedOnly,
		filterOrigin === "all" ? undefined : filterOrigin,
		filterType === "all" ? undefined : filterType,
		filterStatus === "all" ? undefined : filterStatus,
		filterOutcome === "all" ? undefined : filterOutcome
	);
	const deleteRunMutation = useDeleteRunMutation();
	// `mutateAsync` is stable across renders; the mutation object is not.
	const { mutateAsync: setBaseline } = useSetRunBaselineMutation();
	const showToast = useToastStore((s) => s.showToast);

	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);
	const [pinningId, setPinningId] = useState<string | null>(null);

	// The loaded pages flattened (de-duplicated), then filtered and sorted again (see
	// `filterRuns`). `total` is the server's count for the current search and filters.
	const allRuns = flattenRunPages(data);
	const total = runsTotal(data);
	const runs = filterRuns(allRuns, {
		filterType,
		filterStatus,
		pinnedOnly,
		filterOrigin,
		filterOutcome,
		filterClient,
		sortBy,
	});
	// From `allRuns`, not `runs`: see `mcpClientNames`. One agent is not a
	// choice, so the per-client entries wait for a second.
	const clientNames = mcpClientNames(allRuns, filterClient);
	const showClientEntries = clientNames.length > 1 || filterClient !== null;
	const originValue = filterClient === null ? filterOrigin : CLIENT_VALUE_PREFIX + filterClient;
	const handleOriginChange = (value: string) => {
		if (value.startsWith(CLIENT_VALUE_PREFIX)) {
			// The kind first: changing it drops the client, which is then set.
			setFilterOrigin("mcp");
			setFilterClient(value.slice(CLIENT_VALUE_PREFIX.length));
			return;
		}
		setFilterOrigin(value as FilterOrigin);
	};
	const originNarrowing = filterOrigin !== "all" || filterClient !== null;
	const isNarrowed =
		searchQuery !== "" ||
		filterType !== "all" ||
		filterStatus !== "all" ||
		filterOutcome !== "all" ||
		originNarrowing;
	/*
	 * Only the first `visible` rows are mounted; the rest arrive as the end is reached
	 * (`useGrowingWindow` says why a growing window, not a virtual one: rows vary in height).
	 * Slicing before grouping equals slicing after, as a group is a run of adjacent same-day rows.
	 *
	 * The window's identity is the question asked, not the row count: the 5s poll and "Load older
	 * runs" both change the length of the same list and must not shut a window the reader has
	 * scrolled into.
	 */
	const windowKey = JSON.stringify([
		debouncedSearch,
		pinnedOnly,
		filterOrigin,
		filterClient,
		filterType,
		filterStatus,
		filterOutcome,
		sortBy,
	]);
	const {
		visible,
		sentinelRef,
		hasMore: hasUnrenderedRuns,
		showMore,
	} = useGrowingWindow(runs.length, undefined, windowKey);
	// Grouped after sorting/filtering, never before - a group is a label over
	// whatever order `runs` is already in, not a second decision about it.
	const runGroups = groupRunsByDay(runs.slice(0, visible));

	// Roving tabindex over the row activators in this container; `useHistoryListFocus` says why
	// arrow keys move focus without opening a row.
	const listRef = useRef<HTMLDivElement>(null);
	const { onKeyDown: onListKeyDown, onFocus: onListFocus } = useHistoryListFocus(
		listRef,
		hasUnrenderedRuns ? showMore : undefined
	);

	/*
	 * A collection run's row carries the collection's id, not its name: the engine builds the list
	 * row from the run's snapshot and never joins. The tree is already loaded and cached, so naming
	 * it here costs one shared query per page, not one per row.
	 *
	 * A collection deleted since its run resolves to nothing and the row falls back to the id; a
	 * guessed name for a collection that is gone would be the one answer worse than the id.
	 */
	const { data: collections = [] } = useCollectionsQuery();
	const collectionName = (run: Run): string | undefined => {
		const id = run.summary?.scenario?.collectionId;
		if (!id) return undefined;
		return collections.find((c) => c.id === id)?.name;
	};

	/*
	 * The collections tree already says when its load failed; a history list answering the same
	 * failure with "No runs yet" is wrong, and makes one event look like two depending on which of
	 * the drawer's views is open. (This list offers no create CTA, so this is symmetry, not a guard
	 * against a duplicate.)
	 *
	 * Gated on `allRuns`, not the filtered `runs`: TanStack keeps the last good data through a
	 * failed background refetch, and a filter matching nothing is still a working list. Only a
	 * failure with nothing cached earns the error pane.
	 */
	const showError = isError && allRuns.length === 0;

	const runToDelete = deleteConfirmRunId
		? allRuns.find((r) => r.id === deleteConfirmRunId)
		: null;
	const deleteConfirmLabel =
		runToDelete?.summary?.url ??
		(deleteConfirmRunId ? `${deleteConfirmRunId.slice(0, 8)}…` : "");
	// Deleting a live run stops it first, a second consequence the dialog has to name: "removed
	// permanently" does not cover ending a test still generating load.
	const deleteConfirmStopsRun = useRunLiveness(runToDelete?.id, runToDelete?.status);

	// Naming the run deletes it even pinned, unlike Clear run history, which
	// keeps baselines - so the dialog says what the pin is about to lose.
	const deleteConfirmDescription = [
		deleteConfirmStopsRun
			? "This run is still in progress - deleting it stops it first, then removes it permanently."
			: "This run is removed permanently.",
		runToDelete?.baseline && "This run is pinned as a baseline.",
		"This can't be undone.",
	]
		.filter(Boolean)
		.join(" ");

	const handleDeleteClick = useCallback((runId: string, event?: React.MouseEvent) => {
		// Absent when the row's menu is what asked: a menu selection is not a
		// click on the card behind it, so there is nothing to stop.
		event?.stopPropagation();
		setDeleteConfirmRunId(runId);
	}, []);

	/**
	 * No confirmation step: unlike a delete, both directions are one click from undone, and the pin
	 * is visible on the row either way.
	 */
	const handleToggleBaseline = useCallback(
		async (runId: string, baseline: boolean, event?: React.MouseEvent) => {
			event?.stopPropagation();
			setPinningId(runId);
			try {
				await setBaseline({ runId, baseline });
			} catch {
				// Same reason the delete path toasts: a silent rejection leaves the
				// row exactly as it was, which reads as the click not registering.
				showToast(
					baseline
						? "Couldn't pin this run as the baseline."
						: "Couldn't unpin this run.",
					"error"
				);
			} finally {
				setPinningId(null);
			}
		},
		[setBaseline, showToast]
	);

	const handleConfirmDelete = async () => {
		if (!deleteConfirmRunId) return;
		const runIdToDelete = deleteConfirmRunId;
		setDeleteConfirmRunId(null);
		setDeletingId(runIdToDelete);
		try {
			await deleteRunMutation.mutateAsync(runIdToDelete);
			// The run is gone; its tabs are persisted, so leaving them open would
			// rehydrate a pane for a run that cannot load on every restart.
			closeTabsForEntities([runIdToDelete], "run");
			if (selectedRunId === runIdToDelete) {
				navigateToHistory();
			}
		} catch (error) {
			// Otherwise the rejection is unhandled and the row stays with no explanation, which
			// reads as the click not registering.
			showToast(deleteRunErrorMessage(error), "error");
		} finally {
			setDeletingId(null);
		}
	};

	return (
		<DrawerPanel
			title="History"
			actions={
				total > 0 ? (
					<span className="text-xs text-muted-foreground shrink-0">
						{formatNumber(total)} {pluralize(total, "run")}
					</span>
				) : undefined
			}
		>
			{/*
			 * pt-2 is not decorative: the panel body scrolls and clips at its edge, and the search
			 * field's focus ring is drawn *outside* its border box, so flush against the top the
			 * ring's upper edge is cut off. The Variables view uses the same 8px top inset.
			 */}
			<div className="flex h-full w-full flex-col space-y-4 px-3 pt-2 pb-3">
				{/* Search & Filters */}
				<div className="space-y-3 shrink-0">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 size-icon text-muted-foreground" />
						<Input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search runs"
							className="pl-10 w-full"
						/>
					</div>

					<div className="flex gap-2 flex-wrap">
						<Select
							value={filterType}
							onValueChange={(v) => setFilterType(v as FilterType)}
						>
							<SelectTrigger className="flex-1 min-w-[120px]" aria-label="Run type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All types</SelectItem>
								<SelectItem value="load">{RUN_TYPE_NAME.load}</SelectItem>
								<SelectItem value="design">{RUN_TYPE_NAME.design}</SelectItem>
								<SelectItem value="scenario">{RUN_TYPE_NAME.scenario}</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filterStatus}
							onValueChange={(v) => setFilterStatus(v as FilterStatus)}
						>
							<SelectTrigger className="flex-1 min-w-[120px]" aria-label="Status">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All statuses</SelectItem>
								<SelectItem value="pending">Pending</SelectItem>
								<SelectItem value="running">Running</SelectItem>
								<SelectItem value="completed">Completed</SelectItem>
								<SelectItem value="stopped">Stopped</SelectItem>
								<SelectItem value="failed">Failed</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filterOutcome}
							onValueChange={(v) => setFilterOutcome(v as FilterOutcome)}
						>
							<SelectTrigger className="flex-1 min-w-[120px]" aria-label="Outcome">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All outcomes</SelectItem>
								<SelectItem value="failed">Failed</SelectItem>
								<SelectItem value="not_judged">Not judged</SelectItem>
								<SelectItem value="passed">Passed</SelectItem>
							</SelectContent>
						</Select>

						<Select value={originValue} onValueChange={handleOriginChange}>
							<SelectTrigger className="flex-1 min-w-[120px]" aria-label="Origin">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All origins</SelectItem>
								<SelectItem value="app">App</SelectItem>
								<SelectItem value="mcp">Agents</SelectItem>
								{showClientEntries &&
									clientNames.map((name) => (
										<SelectItem key={name} value={CLIENT_VALUE_PREFIX + name}>
											{name}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</div>

					<div className="flex items-center gap-2 flex-wrap">
						<span className="text-xs text-muted-foreground font-medium shrink-0">
							Sort:
						</span>
						<div className="flex gap-1">
							<Button
								variant={sortBy === "newest" ? "default" : "ghost"}
								onClick={() => setSortBy("newest")}
								size="sm"
								className="h-control-sm"
							>
								Newest
							</Button>
							<Button
								variant={sortBy === "oldest" ? "default" : "ghost"}
								onClick={() => setSortBy("oldest")}
								size="sm"
								className="h-control-sm"
							>
								Oldest
							</Button>
						</div>
						{/*
						 * The pin is a toggle, not a Select, so it sits apart from them although it
						 * too is asked of the engine (`baseline=true`). `aria-pressed` because it
						 * is a toggle, not a navigation; the variant swap alone says nothing to a
						 * screen reader.
						 */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant={pinnedOnly ? "default" : "ghost"}
									onClick={() => setPinnedOnly(!pinnedOnly)}
									size="sm"
									className="h-control-sm gap-1 ml-auto"
									aria-pressed={pinnedOnly}
								>
									<Pin
										className="size-icon-sm shrink-0"
										data-icon-motion={ICON_MOTION.tiltPin}
									/>
									Pinned
								</Button>
							</TooltipTrigger>
							<TooltipContent>Show only pinned runs</TooltipContent>
						</Tooltip>
					</div>
				</div>

				{/* Runs List */}
				<div className="flex-1 min-h-0 overflow-hidden">
					{/* No `-mr-2`: the parent clips, so a scrollbar in its padding gets cut. */}
					{/* Scrollbar styling is a global baseline (index.css), not per container. */}
					{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- roving tabindex for Up/Down/Home/End between the row activators inside (see useHistoryListFocus); `role="group"` names this as a set of buttons rather than claiming full `listbox`/`tree` semantics an occasionally-day-headered flat list does not have */}
					<div
						ref={listRef}
						role="group"
						aria-label="Run history"
						onKeyDown={onListKeyDown}
						onFocus={onListFocus}
						className="h-full space-y-1 overflow-y-auto"
					>
						{isLoading && (
							<ListSkeleton rows={4} leading badge className="enter-fade" />
						)}

						{!isLoading && showError && (
							// `h-full` for the same reason as the empty state below:
							// the parent is a scroll container, not a flex column, so
							// the pane variant's `flex-1` has nothing to grow against.
							<ErrorState
								className="h-full enter-fade"
								title="Couldn't load run history"
								detail={error instanceof Error ? error.message : undefined}
								onRetry={() => void refetch()}
							/>
						)}

						{/*
						 * Not while older pages remain: the engine filters, so an empty loaded set
						 * with `hasNextPage` is a patched page (an unpin dropped the last pinned
						 * row) with more behind it, and "no runs found" or "clear the filters"
						 * would be false; "Load older runs" is the way on.
						 */}
						{!isLoading && !showError && runs.length === 0 && !hasNextPage && (
							// `h-full`: this scroll container is not a flex column, so `flex-1` has
							// nothing to grow against, and the block would sit at the top while the
							// collections drawer (a flex column) centres.
							<EmptyState
								className="h-full"
								icon={Clock}
								title={
									pinnedOnly
										? "No pinned runs found"
										: isNarrowed
											? "No runs found"
											: "No runs yet"
								}
								description={
									// Order matters: with a search or a Select
									// narrowing the list, "pin a run" would be
									// advice for a state the user is not in.
									isNarrowed
										? "Try widening the search or clearing the filters."
										: pinnedOnly
											? "Pin a run to keep it here."
											: "Every send, collection run and load test is recorded here."
								}
								action={
									// Only when a control is doing the narrowing:
									// "Clear the filters" is not an offer to make
									// when the list is empty because nothing ran.
									isNarrowed ? (
										<Button
											variant="link"
											onClick={() => {
												setSearchQuery("");
												setFilterType("all");
												setFilterStatus("all");
												setFilterOutcome("all");
												// Drops the client with it.
												setFilterOrigin("all");
											}}
										>
											Clear the filters
										</Button>
									) : undefined
								}
							/>
						)}

						{!isLoading &&
							runGroups.map((group) => (
								// Keyed by the day, not by its first run: a run landing at
								// the head of "Today" would change the key and remount every
								// row of the group, memoised or not. A day is one contiguous
								// group in either sort, so the label is unique.
								<div key={group.label} className="space-y-1">
									{/*
									 * The day-group header replaces a per-row relative timestamp,
									 * which repeated "8h ago" down a page of same-day runs (see
									 * `group-runs-by-day.ts`).
									 */}
									<Eyebrow className="px-1 pt-1 first:pt-0">
										{group.label}
									</Eyebrow>
									{group.runs.map((run) => (
										// `skip-offscreen`: the browser skips layout and paint for
										// mounted rows scrolled past, the pairing `useGrowingWindow`
										// describes. 3.5rem is a row with a result line; the real
										// height is remembered once seen.
										<div
											key={run.id}
											className="skip-offscreen [--skip-offscreen-size:3.5rem]"
										>
											<RunItem
												run={run}
												onSelect={navigateToRunDetail}
												onDelete={handleDeleteClick}
												onToggleBaseline={handleToggleBaseline}
												onCompare={openRunComparison}
												isDeleting={deletingId === run.id}
												isTogglingBaseline={pinningId === run.id}
												isSelected={selectedRunId === run.id}
												collectionName={collectionName(run)}
											/>
										</div>
									))}
								</div>
							))}

						{/* The sentinel: reaching it mounts the next slice of what is
						    already loaded. The count is stated rather than left to a
						    scrollbar, as the console's and a scenario's steps are. */}
						{!isLoading && hasUnrenderedRuns && (
							<p
								ref={sentinelRef}
								className="px-1 py-2 text-xs text-muted-foreground"
							>
								Showing {formatNumber(visible)} of {formatNumber(runs.length)} runs
								- scroll for more.
							</p>
						)}

						{/* Older runs page in on demand - the poll only refreshes
						    the first page. Not while loaded runs remain unmounted:
						    the sentinel above is the end of the list until then. */}
						{!isLoading && !showError && hasNextPage && !hasUnrenderedRuns && (
							<Button
								variant="ghost"
								size="sm"
								className="w-full"
								onClick={() => void fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? "Loading…" : "Load older runs"}
							</Button>
						)}
					</div>
				</div>

				<DeleteConfirmDialog
					open={!!deleteConfirmRunId}
					onOpenChange={(open) => !open && setDeleteConfirmRunId(null)}
					title="Delete run?"
					confirmLabel="Delete run"
					description={
						<>
							{deleteConfirmDescription}
							{deleteConfirmLabel && (
								<TruncatedText
									as="span"
									className="mt-2 block font-mono text-xs text-muted-foreground"
								>
									{deleteConfirmLabel}
								</TruncatedText>
							)}
						</>
					}
					onConfirm={handleConfirmDelete}
					isDeleting={!!deletingId}
				/>
			</div>
		</DrawerPanel>
	);
}
