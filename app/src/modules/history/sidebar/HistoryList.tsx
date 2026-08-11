/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { Search, Clock } from "lucide-react";
import { useTabsStore, useLayoutStore, useToastStore } from "@/stores";
import { ApiError } from "@/services";
import {
	useHistoryStore,
	filterRuns,
	type FilterStatus,
	type FilterType,
} from "@/modules/history/history-store";
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
} from "@/components/ui";
import RunItem from "./RunItem";
import type { Run } from "@/types";

/**
 * A run that is still executing is stopped by the engine before it is deleted,
 * and the delete is refused with a 409 if the run's worker has not finished
 * writing within the engine's wait - deleting rows out from under a live writer
 * is what used to orphan metrics against a deleted run id. Nothing is removed in
 * that case, so the right thing to tell the user is to try again shortly.
 *
 * The engine's error body is a bare `{"error": "..."}` string, which the shared
 * http client cannot read into `ApiError.message` (it looks for `error.message`),
 * so the wording lives here rather than being echoed from the response.
 */
function deleteRunErrorMessage(error: unknown): string {
	if (error instanceof ApiError && error.statusCode === 409) {
		return "This run is still stopping - try deleting it again in a moment";
	}
	return error instanceof Error ? `Couldn't delete run: ${error.message}` : "Couldn't delete run";
}

export default function HistoryList() {
	const { openTab, openTabs, activeTabId, closeTabsForEntities } = useTabsStore();
	const { activateDrawerView } = useLayoutStore();
	const {
		searchQuery,
		setSearchQuery,
		filterType,
		setFilterType,
		filterStatus,
		setFilterStatus,
		sortBy,
		setSortBy,
	} = useHistoryStore();

	// Get selectedRunId from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRunId = activeTab?.type === "run" ? activeTab.entityId : null;

	const navigateToRunDetail = (runId: string) => openTab({ type: "run", entityId: runId });
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
	} = useRunsQuery(debouncedSearch);
	const deleteRunMutation = useDeleteRunMutation();
	const setBaselineMutation = useSetRunBaselineMutation();
	const showToast = useToastStore((s) => s.showToast);

	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);
	const [pinningId, setPinningId] = useState<string | null>(null);

	// Flatten (de-duped) the loaded pages, then apply the client-side type/
	// status/sort filters over them. `total` is the server's count for the
	// current search.
	const allRuns = flattenRunPages(data);
	const total = runsTotal(data);
	const runs = filterRuns(allRuns, { filterType, filterStatus, sortBy });

	/*
	 * A collection run's row carries the collection's id, not its name - the
	 * engine's list row is built from the run's snapshot and never joins. The
	 * name is here instead: the tree is already loaded and cached, so this costs
	 * one shared query for the whole page rather than one per row.
	 *
	 * A collection deleted since its run resolves to nothing, and the row falls
	 * back to the id it does have. Guessing a name for a folder that is gone
	 * would be the one answer worse than the id.
	 */
	const { data: collections = [] } = useCollectionsQuery();
	const collectionName = (run: Run): string | undefined => {
		const id = run.summary?.scenario?.collectionId;
		if (!id) return undefined;
		return collections.find((c) => c.id === id)?.name;
	};

	/*
	 * The drawer has three sibling views. The collections tree already tells the
	 * user when its load failed; a history list that answers the same failure
	 * with "No test runs found" is not just wrong on its own terms, it makes the
	 * same event look like two different events depending on which view is open.
	 * Nothing here offers a create CTA, so this is about that symmetry rather
	 * than about preventing a duplicate.
	 *
	 * Gated on `allRuns`, not the filtered `runs`: TanStack keeps the last good
	 * data through a failed background refetch, and a filter that happens to
	 * match nothing is still a working list. Only a failure with nothing cached
	 * earns the error pane.
	 */
	const showError = isError && allRuns.length === 0;

	const runToDelete = deleteConfirmRunId
		? allRuns.find((r) => r.id === deleteConfirmRunId)
		: null;
	const deleteConfirmLabel =
		runToDelete?.summary?.url ??
		(deleteConfirmRunId ? `${deleteConfirmRunId.slice(0, 8)}…` : "");
	// Deleting one of these stops it first, which is a second consequence the
	// dialog has to name - "permanently removed" alone does not cover ending a
	// test that is still generating load.
	const deleteConfirmStopsRun =
		runToDelete?.status === "running" || runToDelete?.status === "pending";

	const handleDeleteClick = (runId: string, event: React.MouseEvent) => {
		event.stopPropagation();
		setDeleteConfirmRunId(runId);
	};

	/**
	 * Pin or unpin without a confirmation step: unlike a delete, both
	 * directions are one click away from being undone, and the pin is visible
	 * on the row either way.
	 */
	const handleToggleBaseline = async (
		runId: string,
		baseline: boolean,
		event: React.MouseEvent
	) => {
		event.stopPropagation();
		setPinningId(runId);
		try {
			await setBaselineMutation.mutateAsync({ runId, baseline });
		} catch {
			// Same reason the delete path toasts: a silent rejection leaves the
			// row exactly as it was, which reads as the click not registering.
			showToast(
				baseline ? "Couldn't pin this run as the baseline." : "Couldn't unpin this run.",
				"error"
			);
		} finally {
			setPinningId(null);
		}
	};

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
			// Without this the rejection was unhandled: the row stayed in the
			// list with no explanation, which reads as the click not registering.
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
						{total} {total === 1 ? "run" : "runs"}
					</span>
				) : undefined
			}
		>
			{/*
			 * pt-2 is not decorative. The panel body scrolls, so it clips at its
			 * own edge, and the search field's focus ring is drawn *outside* its
			 * border box - flush against the top, the ring's upper edge was cut
			 * off. Matches the 8px top inset the Variables view already uses.
			 */}
			<div className="flex h-full w-full flex-col space-y-4 px-3 pt-2 pb-3">
				{/* Search & Filters */}
				<div className="space-y-3 shrink-0">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
						<Input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search runs by api..."
							className="pl-10 w-full"
						/>
					</div>

					<div className="flex gap-2 flex-wrap">
						<Select
							value={filterType}
							onValueChange={(v) => setFilterType(v as FilterType)}
						>
							<SelectTrigger className="flex-1 min-w-[120px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Types</SelectItem>
								<SelectItem value="load">Load Test</SelectItem>
								<SelectItem value="design">Design Mode</SelectItem>
								<SelectItem value="scenario">Collection Run</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filterStatus}
							onValueChange={(v) => setFilterStatus(v as FilterStatus)}
						>
							<SelectTrigger className="flex-1 min-w-[120px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Status</SelectItem>
								<SelectItem value="pending">Pending</SelectItem>
								<SelectItem value="running">Running</SelectItem>
								<SelectItem value="completed">Completed</SelectItem>
								<SelectItem value="stopped">Stopped</SelectItem>
								<SelectItem value="failed">Failed</SelectItem>
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
								className="h-8"
							>
								Newest
							</Button>
							<Button
								variant={sortBy === "oldest" ? "default" : "ghost"}
								onClick={() => setSortBy("oldest")}
								size="sm"
								className="h-8"
							>
								Oldest
							</Button>
						</div>
					</div>
				</div>

				{/* Runs List */}
				<div className="flex-1 min-h-0 overflow-hidden">
					{/*
					 * No `-mr-2` here. That trick lets a scrollbar sit in the
					 * parent's padding, but the parent clips (overflow-hidden), so
					 * it pushed the scrollbar 8px past the clip edge and cut it off
					 * lengthwise. Stay inside the parent and pad the content instead.
					 *
					 * Scrollbar styling is a global baseline (index.css) - nothing to
					 * apply per container, which is what this element was missing.
					 */}
					<div className="h-full space-y-2 overflow-y-auto pr-1">
						{isLoading && <ListSkeleton rows={4} leading badge />}

						{!isLoading && showError && (
							// `h-full` for the same reason as the empty state below:
							// the parent is a scroll container, not a flex column, so
							// the pane variant's `flex-1` has nothing to grow against.
							<ErrorState
								className="h-full"
								title="Couldn't load run history"
								detail={error instanceof Error ? error.message : undefined}
								onRetry={() => void refetch()}
							/>
						)}

						{!isLoading && !showError && runs.length === 0 && (
							// `h-full` because this scroll container is not a flex
							// column, so `flex-1` has nothing to grow against. Without
							// it the block sits at the top while the collections
							// drawer - whose container *is* a flex column - centres.
							<EmptyState
								className="h-full"
								icon={Clock}
								title="No test runs found"
								description={
									searchQuery || filterType !== "all" || filterStatus !== "all"
										? "Try widening the search or clearing the filters."
										: "Run your first load test to see its results here."
								}
							/>
						)}

						{!isLoading &&
							runs.map((run) => (
								<RunItem
									key={run.id}
									run={run}
									onSelect={navigateToRunDetail}
									onDelete={handleDeleteClick}
									onToggleBaseline={handleToggleBaseline}
									isDeleting={deletingId === run.id}
									isTogglingBaseline={pinningId === run.id}
									isSelected={selectedRunId === run.id}
									collectionName={collectionName(run)}
								/>
							))}

						{/* Older runs page in on demand - the poll only refreshes
						    the first page. */}
						{!isLoading && !showError && hasNextPage && (
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
					description={
						<>
							{deleteConfirmStopsRun
								? "This run is still in progress - deleting it stops it first, then removes it permanently. This cannot be undone."
								: "This run will be permanently removed. This cannot be undone."}
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
