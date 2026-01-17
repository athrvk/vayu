
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { Search, Clock, Loader2 } from "lucide-react";
import { useNavigationStore, useHistoryStore } from "@/stores";
import { filterRuns } from "@/stores/history-store";
import { useRunsQuery, useDeleteRunMutation } from "@/queries";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import RunItem from "./RunItem";

export default function HistoryList() {
	const { navigateToRunDetail } = useNavigationStore();
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

	// Use TanStack Query for runs data
	const { data: allRuns = [], isLoading } = useRunsQuery();
	const deleteRunMutation = useDeleteRunMutation();

	const [deletingId, setDeletingId] = useState<string | null>(null);

	// Filter and sort runs using the helper function
	const runs = filterRuns(allRuns, { searchQuery, filterType, filterStatus, sortBy });

	const handleDelete = async (runId: string, event: React.MouseEvent) => {
		event.stopPropagation();
		if (confirm("Delete this run?")) {
			setDeletingId(runId);
			await deleteRunMutation.mutateAsync(runId);
			setDeletingId(null);
		}
	};

	return (
		<div className="flex flex-col h-full w-full p-4 space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<Clock className="w-4 h-4 text-primary shrink-0" />
					<h2 className="text-sm font-semibold text-foreground truncate">
						History of Runs
					</h2>
				</div>
				{allRuns.length > 0 && (
					<span className="text-xs text-muted-foreground shrink-0 ml-2">
						{allRuns.length} {allRuns.length === 1 ? "run" : "runs"}
					</span>
				)}
			</div>

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

					<Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as any)}>
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
				<div className="space-y-2 h-full overflow-y-auto pr-2 -mr-2">
					{isLoading && (
						<div className="flex flex-col items-center justify-center py-16">
							<Loader2 className="w-8 h-8 text-primary animate-spin mb-3" />
							<p className="text-sm text-muted-foreground">Loading runs...</p>
						</div>
					)}

					{!isLoading && runs.length === 0 && (
						<div className="text-center py-16">
							<div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted/50 flex items-center justify-center">
								<Clock className="w-8 h-8 text-muted-foreground/40" />
							</div>
							<p className="text-sm font-medium text-foreground">
								No test runs found
							</p>
							<p className="text-xs text-muted-foreground mt-1">
								{searchQuery || filterType !== "all" || filterStatus !== "all"
									? "Try adjusting your filters"
									: "Run your first load test to see results here"}
							</p>
						</div>
					)}

					{!isLoading &&
						runs.map((run) => (
							<RunItem
								key={run.id}
								run={run}
								onSelect={navigateToRunDetail}
								onDelete={handleDelete}
								isDeleting={deletingId === run.id}
							/>
						))}
				</div>
			</div>
		</div>
	);
}
