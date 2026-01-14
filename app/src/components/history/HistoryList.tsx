import { useState } from "react";
import { Search, Trash2, Clock, Loader2, Activity, Zap, CheckCircle2, XCircle, StopCircle } from "lucide-react";
import { useAppStore, useHistoryStore } from "@/stores";
import { filterRuns } from "@/stores/history-store";
import { useRunsQuery, useDeleteRunMutation } from "@/queries";
import { formatRelativeTime } from "@/utils";
import type { Run } from "@/types";
import { Button, Input, Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, ScrollArea } from "@/components/ui";
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
		<div className="flex flex-col h-full bg-background">
			{/* Header */}
			<div className="px-4 py-3 border-b">
				<h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
					<Clock className="w-5 h-5 text-primary" />
					Test History
				</h2>
				<p className="text-xs text-muted-foreground mt-0.5">
					{allRuns.length} {allRuns.length === 1 ? 'run' : 'runs'} total
				</p>
			</div>

			{/* Search & Filters */}
			<div className="px-4 py-3 border-b space-y-3 bg-muted/30">
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

				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground font-medium">Sort:</span>
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
			<ScrollArea className="flex-1">
				<div className="p-3 space-y-2">
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
							<p className="text-sm font-medium text-foreground">No test runs found</p>
							<p className="text-xs text-muted-foreground mt-1">
								{searchQuery || filterType !== 'all' || filterStatus !== 'all'
									? 'Try adjusting your filters'
									: 'Run your first load test to see results here'}
							</p>
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
			</ScrollArea>
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
	// Format timestamp to relative time
	const formatTime = (timestamp: number) => {
		if (!timestamp) return "Unknown";
		return formatRelativeTime(new Date(timestamp).toISOString());
	};

	// Get URL and method from configSnapshot
	const getRequestInfo = () => {
		if (!run.configSnapshot) return { url: null, method: null };
		const url = run.configSnapshot.request?.url || run.configSnapshot.url || null;
		const method = run.configSnapshot.request?.method || run.configSnapshot.method || 'GET';
		return { url, method };
	};

	const { url: requestUrl, method } = getRequestInfo();

	// Get status icon and color
	const getStatusIcon = () => {
		switch (run.status) {
			case 'completed':
				return <CheckCircle2 className="w-4 h-4 text-green-500" />;
			case 'failed':
				return <XCircle className="w-4 h-4 text-red-500" />;
			case 'running':
				return <Activity className="w-4 h-4 text-blue-500 animate-pulse" />;
			case 'stopped':
				return <StopCircle className="w-4 h-4 text-orange-500" />;
			default:
				return <Clock className="w-4 h-4 text-muted-foreground" />;
		}
	};

	return (
		<div
			onClick={() => onSelect(run.id)}
			className="group relative bg-card border rounded-lg hover:border-primary hover:shadow-sm cursor-pointer transition-all overflow-hidden"
		>
			{/* Status color indicator */}
			<div className={cn(
				"absolute left-0 top-0 bottom-0 w-1",
				run.status === 'completed' && "bg-green-500",
				run.status === 'failed' && "bg-red-500",
				run.status === 'running' && "bg-blue-500",
				run.status === 'stopped' && "bg-orange-500",
				run.status === 'pending' && "bg-muted-foreground"
			)} />

			<div className="pl-4 pr-3 py-3">
				{/* Header Row */}
				<div className="flex items-start justify-between gap-2 mb-2">
					<div className="flex items-center gap-2 min-w-0 flex-1">
						{getStatusIcon()}
						<span className={cn(
							"text-xs font-medium capitalize",
							run.status === 'completed' && "text-green-600 dark:text-green-400",
							run.status === 'failed' && "text-red-600 dark:text-red-400",
							run.status === 'running' && "text-blue-600 dark:text-blue-400",
							run.status === 'stopped' && "text-orange-600 dark:text-orange-400",
							run.status === 'pending' && "text-muted-foreground"
						)}>
							{run.status}
						</span>
						<span className="text-xs text-muted-foreground">•</span>
						<span className="text-xs text-muted-foreground">{formatTime(run.startTime)}</span>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{run.type === 'load' && (
							<Zap className="w-3.5 h-3.5 text-purple-500" />
						)}
						<Button
							variant="ghost"
							size="icon"
							onClick={(e) => onDelete(run.id, e)}
							disabled={isDeleting}
							className="opacity-0 group-hover:opacity-100 h-7 w-7 hover:bg-destructive/10 hover:text-destructive transition-opacity"
						>
							{isDeleting ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
							) : (
								<Trash2 className="w-3.5 h-3.5" />
							)}
						</Button>
					</div>
				</div>

				{/* Request Info */}
				{requestUrl && (
					<div className="flex items-start gap-2 mb-1">
						{method && (
							<Badge variant="outline" className={cn(
								"text-[10px] h-5 px-1.5 font-mono shrink-0",
								method === 'GET' && "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900",
								method === 'POST' && "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-900",
								method === 'PUT' && "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900",
								method === 'DELETE' && "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-900"
							)}>
								{method}
							</Badge>
						)}
						<p className="text-xs text-foreground font-medium truncate flex-1 leading-5">
							{requestUrl}
						</p>
					</div>
				)}

				{/* Config Info (if load test) */}
				{run.type === 'load' && run.configSnapshot?.configuration && (
					<div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1.5">
						{run.configSnapshot.configuration.duration && (
							<span className="flex items-center gap-1">
								<Clock className="w-3 h-3" />
								{run.configSnapshot.configuration.duration}
							</span>
						)}
						{run.configSnapshot.configuration.concurrency && (
							<span className="flex items-center gap-1">
								<Activity className="w-3 h-3" />
								{run.configSnapshot.configuration.concurrency} workers
							</span>
						)}
					</div>
				)}

				{/* Comment if exists */}
				{run.configSnapshot?.configuration?.comment && (
					<p className="text-xs text-muted-foreground italic mt-1.5 truncate">
						"{run.configSnapshot.configuration.comment}"
					</p>
				)}
			</div>
		</div>
	);
}
