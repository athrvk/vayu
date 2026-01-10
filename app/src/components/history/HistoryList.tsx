import { useEffect, useState } from "react";
import { Search, Trash2, Clock, Loader2 } from "lucide-react";
import { useAppStore, useHistoryStore } from "@/stores";
import { useRuns } from "@/hooks";
import { formatRelativeTime, formatNumber } from "@/utils";
import type { Run } from "@/types";

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
		getFilteredRuns,
		isLoading,
		isDeletingRun,
	} = useHistoryStore();
	const { loadRuns, deleteRun } = useRuns();
	const [deletingId, setDeletingId] = useState<string | null>(null);

	useEffect(() => {
		loadRuns();
	}, [loadRuns]);

	const runs = getFilteredRuns();

	const handleDelete = async (runId: string, event: React.MouseEvent) => {
		event.stopPropagation();
		if (confirm("Delete this run?")) {
			setDeletingId(runId);
			await deleteRun(runId);
			setDeletingId(null);
		}
	};

	return (
		<div className="flex flex-col h-full">
			{/* Search & Filters */}
			<div className="p-4 border-b border-gray-200 space-y-3">
				<div className="relative">
					<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search runs..."
						className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
					/>
				</div>

				<div className="flex gap-2">
					<select
						value={filterType}
						onChange={(e) => setFilterType(e.target.value as any)}
						className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
					>
						<option value="all">All Types</option>
						<option value="load">Load Test</option>
						<option value="design">Design Mode</option>
					</select>

					<select
						value={filterStatus}
						onChange={(e) => setFilterStatus(e.target.value as any)}
						className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
					>
						<option value="all">All Status</option>
						<option value="pending">Pending</option>
						<option value="running">Running</option>
						<option value="completed">Completed</option>
						<option value="stopped">Stopped</option>
						<option value="failed">Failed</option>
					</select>
				</div>

				<div className="flex gap-2">
					<button
						onClick={() => setSortBy("newest")}
						className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
							sortBy === "newest"
								? "bg-primary-600 text-white"
								: "bg-gray-100 text-gray-700 hover:bg-gray-200"
						}`}
					>
						Newest First
					</button>
					<button
						onClick={() => setSortBy("oldest")}
						className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
							sortBy === "oldest"
								? "bg-primary-600 text-white"
								: "bg-gray-100 text-gray-700 hover:bg-gray-200"
						}`}
					>
						Oldest First
					</button>
				</div>
			</div>

			{/* Runs List */}
			<div className="flex-1 overflow-auto p-4 space-y-2">
				{isLoading && (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
					</div>
				)}

				{!isLoading && runs.length === 0 && (
					<div className="text-center py-12 text-sm text-gray-500">
						<Clock className="w-12 h-12 mx-auto mb-3 text-gray-300" />
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
	const statusColors: Record<string, string> = {
		pending: "bg-gray-100 text-gray-700",
		running: "bg-blue-100 text-blue-700",
		completed: "bg-green-100 text-green-700",
		stopped: "bg-yellow-100 text-yellow-700",
		failed: "bg-red-100 text-red-700",
	};

	const typeColors: Record<string, string> = {
		load: "bg-purple-100 text-purple-700",
		design: "bg-gray-100 text-gray-700",
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
			className="p-3 bg-white border border-gray-200 rounded hover:border-primary-500 cursor-pointer transition-colors group"
		>
			<div className="flex items-start justify-between mb-2">
				<div className="flex items-center gap-2">
					<span
						className={`text-xs px-2 py-0.5 rounded font-medium ${
							typeColors[run.type] || typeColors.design
						}`}
					>
						{run.type === "design" ? "DESIGN" : "LOAD TEST"}
					</span>
					<span
						className={`text-xs px-2 py-0.5 rounded font-medium ${
							statusColors[run.status] || statusColors.pending
						}`}
					>
						{run.status}
					</span>
				</div>
				<button
					onClick={(e) => onDelete(run.id, e)}
					disabled={isDeleting}
					className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 rounded transition-all disabled:opacity-50"
					title="Delete Run"
				>
					{isDeleting ? (
						<Loader2 className="w-4 h-4 text-red-600 animate-spin" />
					) : (
							<Trash2 className="w-4 h-4 text-red-600" />
					)}
				</button>
			</div>

			<p className="text-sm font-medium text-gray-900 mb-1 truncate">
				{requestUrl || run.id}
			</p>

			<div className="flex items-center gap-3 text-xs text-gray-600">
				<span>{formatTime(run.startTime)}</span>
			</div>
		</div>
	);
}
