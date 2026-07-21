/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type React from "react";
import { formatRelativeTime, loadTestTypeToLabel } from "@/utils";
import type { Run } from "@/types";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { MethodBadge } from "@/components/shared";
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

export default function RunItem({
	run,
	onSelect,
	onDelete,
	isDeleting,
	isSelected = false,
}: RunItemProps) {
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
				return <CheckCircle2 className="w-4 h-4 text-status-success" />;
			case "failed":
				return <XCircle className="w-4 h-4 text-status-error" />;
			case "running":
				return <Activity className="w-4 h-4 text-status-running animate-pulse" />;
			case "stopped":
				return <StopCircle className="w-4 h-4 text-status-stopped" />;
			default:
				return <Clock className="w-4 h-4 text-muted-foreground" />;
		}
	};

	return (
		<div
			onClick={() => onSelect(run.id)}
			className={cn(
				"group relative bg-card border cursor-pointer transition-all transition-colors overflow-hidden w-full",
				isSelected
					? "bg-primary/10 hover:bg-primary/15 border-primary/50 ring-1 ring-inset ring-primary/20 shadow-sm"
					: "hover:border-primary/50 hover:shadow-sm"
			)}
		>
			{/* Status color indicator */}
			<div
				className={cn(
					"absolute left-0 top-0 bottom-0 w-1",
					run.status === "completed" && "bg-status-success",
					run.status === "failed" && "bg-status-error",
					run.status === "running" && "bg-status-running",
					run.status === "stopped" && "bg-status-stopped",
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
								run.status === "completed" && "text-status-success-text",
								run.status === "failed" && "text-status-error-text",
								run.status === "running" && "text-status-running-text",
								run.status === "stopped" && "text-status-stopped-text",
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
							variant="rowActionDestructive"
							size="icon"
							onClick={(e) => onDelete(run.id, e)}
							disabled={isDeleting}
							aria-label={`Delete run`}
							className={cn(
								"h-6 w-6 transition-opacity",
								isDeleting
									? "opacity-100"
									: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
						{method && <MethodBadge method={method} className="h-5 items-center" />}
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
