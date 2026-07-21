/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { Search, Clock } from "lucide-react";
import { useTabsStore, useLayoutStore } from "@/stores";
import { useHistoryStore, filterRuns } from "@/modules/history/history-store";
import { useRunsQuery, useDeleteRunMutation } from "@/queries";
import { DrawerPanel, EmptyState, TruncatedText, ListSkeleton } from "@/components/shared";
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

export default function HistoryList() {
	const { openTab, openTabs, activeTabId } = useTabsStore();
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

	// Use TanStack Query for runs data
	const { data: allRuns = [], isLoading } = useRunsQuery();
	const deleteRunMutation = useDeleteRunMutation();

	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);

	// Filter and sort runs using the helper function
	const runs = filterRuns(allRuns, { searchQuery, filterType, filterStatus, sortBy });

	const runToDelete = deleteConfirmRunId
		? allRuns.find((r) => r.id === deleteConfirmRunId)
		: null;
	const deleteConfirmLabel =
		runToDelete?.configSnapshot?.url ??
		(deleteConfirmRunId ? `${deleteConfirmRunId.slice(0, 8)}…` : "");

	const handleDeleteClick = (runId: string, event: React.MouseEvent) => {
		event.stopPropagation();
		setDeleteConfirmRunId(runId);
	};

	const handleConfirmDelete = async () => {
		if (!deleteConfirmRunId) return;
		const runIdToDelete = deleteConfirmRunId;
		setDeleteConfirmRunId(null);
		setDeletingId(runIdToDelete);
		try {
			await deleteRunMutation.mutateAsync(runIdToDelete);
			if (selectedRunId === runIdToDelete) {
				navigateToHistory();
			}
		} finally {
			setDeletingId(null);
		}
	};

	return (
		<DrawerPanel
			title="History"
			actions={
				allRuns.length > 0 ? (
					<span className="text-xs text-muted-foreground shrink-0">
						{allRuns.length} {allRuns.length === 1 ? "run" : "runs"}
					</span>
				) : undefined
			}
		>
			{/*
			 * pt-2 is not decorative. The panel body scrolls, so it clips at its
			 * own edge, and the search field's focus ring is drawn *outside* its
			 * border box — flush against the top, the ring's upper edge was cut
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
						<Select value={filterType} onValueChange={(v) => setFilterType(v as any)}>
							<SelectTrigger className="flex-1 min-w-[120px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Types</SelectItem>
								<SelectItem value="load">Load Test</SelectItem>
								<SelectItem value="design">Design Mode</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filterStatus}
							onValueChange={(v) => setFilterStatus(v as any)}
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
					 * Scrollbar styling is a global baseline (index.css) — nothing to
					 * apply per container, which is what this element was missing.
					 */}
					<div className="h-full space-y-2 overflow-y-auto pr-1">
						{isLoading && <ListSkeleton rows={4} leading badge />}

						{!isLoading && runs.length === 0 && (
							// `h-full` because this scroll container is not a flex
							// column, so `flex-1` has nothing to grow against. Without
							// it the block sits at the top while the collections
							// drawer — whose container *is* a flex column — centres.
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
									isDeleting={deletingId === run.id}
									isSelected={selectedRunId === run.id}
								/>
							))}
					</div>
				</div>

				<DeleteConfirmDialog
					open={!!deleteConfirmRunId}
					onOpenChange={(open) => !open && setDeleteConfirmRunId(null)}
					title="Delete run?"
					description={
						<>
							This run will be permanently removed. This cannot be undone.
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
