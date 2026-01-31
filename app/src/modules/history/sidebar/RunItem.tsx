
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { formatRelativeTime, loadTestTypeToLabel } from "@/utils";
import type { Run } from "@/types";
import { Button, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
	CheckCircle2,
	XCircle,
	Activity,
	StopCircle,
	Clock,
	Loader2,
	Trash2,
	Zap,
} from "lucide-react";

interface RunItemProps {
	run: Run;
	onSelect: (runId: string) => void;
	onDelete: (runId: string, event: React.MouseEvent) => void;
	isDeleting: boolean;
	isSelected?: boolean;
}

export default function RunItem({ run, onSelect, onDelete, isDeleting, isSelected = false }: RunItemProps) {
	// Format timestamp to relative time
	const formatTime = (timestamp: number) => {
		if (!timestamp) return "Unknown";
		return formatRelativeTime(new Date(timestamp).toISOString());
	};

	// Get URL and method from configSnapshot (unified flat structure)
	const getRequestInfo = () => {
		if (!run.configSnapshot) return { url: null, method: null };
		const url = run.configSnapshot.url || null;
		const method = run.configSnapshot.method || "GET";
		const type = run.configSnapshot.mode;
		return { url, method, type };
	};

	const { url: requestUrl, method, type: loadTestType } = getRequestInfo();

	// Get status icon and color
	const getStatusIcon = () => {
		switch (run.status) {
			case "completed":
				return <CheckCircle2 className="w-4 h-4 text-green-500" />;
			case "failed":
				return <XCircle className="w-4 h-4 text-destructive" />;
			case "running":
				return <Activity className="w-4 h-4 text-blue-500 animate-pulse" />;
			case "stopped":
				return <StopCircle className="w-4 h-4 text-orange-500" />;
			default:
				return <Clock className="w-4 h-4 text-muted-foreground" />;
		}
	};

	return (
		<div
			onClick={() => onSelect(run.id)}
			className={cn(
				"group relative bg-card border cursor-pointer transition-all overflow-hidden w-full",
				isSelected
					? "bg-primary/10 hover:bg-primary/15 border-primary/50 ring-1 ring-inset ring-primary/20 shadow-sm"
					: "hover:border-primary/50 hover:shadow-sm"
			)}
		>
			{/* Status color indicator */}
			<div
				className={cn(
					"absolute left-0 top-0 bottom-0 w-1",
					run.status === "completed" && "bg-green-500",
					run.status === "failed" && "bg-red-500",
					run.status === "running" && "bg-blue-500",
					run.status === "stopped" && "bg-orange-500",
					run.status === "pending" && "bg-muted-foreground"
				)}
			/>

			<div className="pl-4 pr-3 py-3 min-w-0">
				{/* Header Row */}
				<div className="flex items-start justify-between gap-2 mb-2 min-w-0 flex-wrap">
					<div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
						<div className="shrink-0">{getStatusIcon()}</div>
						<span
							className={cn(
								"text-xs font-medium capitalize shrink-0",
								run.status === "completed" && "text-green-600 dark:text-green-400",
								run.status === "failed" && "text-red-600 dark:text-red-400",
								run.status === "running" && "text-blue-600 dark:text-blue-400",
								run.status === "stopped" && "text-orange-600 dark:text-orange-400",
								run.status === "pending" && "text-muted-foreground"
							)}
						>
							{run.status}
						</span>
						<span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
							•
						</span>
						<span className="text-xs text-muted-foreground min-w-0 break-words">
							{formatTime(run.startTime)}
						</span>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{run.type === "load" && (
							<Zap className="w-3.5 h-3.5 text-purple-500 shrink-0" />
						)}
						<Button
							variant="ghost"
							size="icon"
							onClick={(e) => onDelete(run.id, e)}
							disabled={isDeleting}
							className={cn(
								"h-6 w-6 hover:bg-destructive/10 hover:text-destructive transition-opacity",
								isDeleting ? "opacity-100" : "opacity-0 group-hover:opacity-100"
							)}
						>
							{isDeleting ? (
								<Loader2 className="w-3 h-3 animate-spin" />
							) : (
								<Trash2 className="w-3 h-3" />
							)}
						</Button>
					</div>
				</div>

				{/* Request Info */}
				{requestUrl && (
					<div className="flex items-start gap-2 mb-1.5 min-w-0 flex-wrap">
						{method && (
							<Badge
								variant="outline"
								className={cn(
									"text-[10px] h-5 px-1.5 font-mono shrink-0",
									method === "GET" &&
									"bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900",
									method === "POST" &&
									"bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-900",
									method === "PUT" &&
									"bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-900",
									method === "DELETE" &&
									"bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-900"
								)}
							>
								{method}
							</Badge>
						)}
						<p
							className="text-xs text-foreground font-medium break-words flex-1 min-w-0 leading-5"
							title={requestUrl}
						>
							{requestUrl}
						</p>
					</div>
				)}

				{/* Config Info (if load test) */}
				{run.type === "load" && run.configSnapshot && (
					<div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-1.5 flex-wrap">
						{run.configSnapshot.duration && (
							<span className="flex items-center gap-1 shrink-0">
								<Clock className="w-3 h-3" />
								{run.configSnapshot.duration}
							</span>
						)}
						{run.configSnapshot.concurrency && (
							<span className="flex items-center gap-1 shrink-0">
								<Activity className="w-3 h-3" />
								{run.configSnapshot.concurrency} workers
							</span>
						)}
						{loadTestType && (
							<span className="flex items-center gap-1 shrink-0">
								<Zap className="w-3 h-3" />
								{loadTestTypeToLabel(loadTestType)}
							</span>
						)}
					</div>
				)}

				{/* Comment if exists */}
				{run.configSnapshot?.comment && (
					<p className="text-xs text-muted-foreground italic mt-1.5 break-words">
						"{run.configSnapshot.comment}"
					</p>
				)}
			</div>
		</div>
	);
}
