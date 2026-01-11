import { useState } from "react";
import { Search, Trash2, Clock, Loader2 } from "lucide-react";
import { useAppStore, useHistoryStore } from "@/stores";
import { filterRuns } from "@/stores/history-store";
import { useRunsQuery, useDeleteRunMutation } from "@/queries";
import { formatRelativeTime } from "@/utils";
import type { Run } from "@/types";
import { Button, Input, Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui";
import { cn } from "@/lib/utils";

export default function HistoryList() {
	const { navigateToRunDetail } = useAppStore();
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
		<div className="flex flex-col h-full">
			{/* Search & Filters */}
			<div className="p-4 border-b space-y-3">
				<div className="relative">
					<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
					<Input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search runs..."
						className="pl-10"
					/>
				</div>

				<div className="flex gap-2">
					<Select value={filterType} onValueChange={(v) => setFilterType(v as any)}>
						<SelectTrigger className="flex-1">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Types</SelectItem>
							<SelectItem value="load">Load Test</SelectItem>
							<SelectItem value="design">Design Mode</SelectItem>
						</SelectContent>
					</Select>

					<Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as any)}>
						<SelectTrigger className="flex-1">
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

				<div className="flex gap-2">
					<Button
						variant={sortBy === "newest" ? "default" : "secondary"}
						onClick={() => setSortBy("newest")}
						className="flex-1"
						size="sm"
					>
						Newest First
					</Button>
					<Button
						variant={sortBy === "oldest" ? "default" : "secondary"}
						onClick={() => setSortBy("oldest")}
						className="flex-1"
						size="sm"
					>
						Oldest First
					</Button>
				</div>
			</div>

			{/* Runs List */}
			<div className="flex-1 overflow-auto p-4 space-y-2">
				{isLoading && (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="w-8 h-8 text-primary animate-spin" />
					</div>
				)}

				{!isLoading && runs.length === 0 && (
					<div className="text-center py-12 text-sm text-muted-foreground">
						<Clock className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
						<p>No runs found</p>
					</div>
				)}

				{!isLoading && runs.map((run) => (
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
	);
}

interface RunItemProps {
	run: Run;
	onSelect: (runId: string) => void;
	onDelete: (runId: string, event: React.MouseEvent) => Promise<void>;
	isDeleting: boolean;
}

function RunItem({ run, onSelect, onDelete, isDeleting }: RunItemProps) {
	const statusVariants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
		pending: "secondary",
		running: "default",
		completed: "default",
		stopped: "outline",
		failed: "destructive",
	};

	// Format timestamp to relative time
	const formatTime = (timestamp: number) => {
		if (!timestamp) return "Unknown";
		return formatRelativeTime(new Date(timestamp).toISOString());
	};

	// Get URL from configSnapshot if available
	const getRequestInfo = () => {
		if (!run.configSnapshot) return null;
		if (run.configSnapshot.request?.url) {
			return run.configSnapshot.request.url;
		}
		if (run.configSnapshot.url) {
			return run.configSnapshot.url;
		}
		return null;
	};

	const requestUrl = getRequestInfo();

	return (
		<div
			onClick={() => onSelect(run.id)}
			className="p-3 bg-card border rounded hover:border-primary cursor-pointer transition-colors group"
		>
			<div className="flex items-start justify-between mb-2">
				<div className="flex items-center gap-2">
					<Badge variant="outline" className={cn(
						"text-xs",
						run.type === "load"
							? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
							: "bg-muted text-muted-foreground"
					)}>
						{run.type === "design" ? "DESIGN" : "LOAD TEST"}
					</Badge>
					<Badge variant={statusVariants[run.status] || "secondary"} className="text-xs">
						{run.status}
					</Badge>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={(e) => onDelete(run.id, e)}
					disabled={isDeleting}
					className="opacity-0 group-hover:opacity-100 h-6 w-6 hover:bg-destructive/10 hover:text-destructive transition-all"
				>
					{isDeleting ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
							<Trash2 className="w-4 h-4" />
					)}
				</Button>
			</div>

			<p className="text-sm font-medium text-foreground mb-1 truncate">
				{requestUrl || run.id}
			</p>

			<div className="flex items-center gap-3 text-xs text-muted-foreground">
				<span>{formatTime(run.startTime)}</span>
			</div>
		</div>
	);
}
