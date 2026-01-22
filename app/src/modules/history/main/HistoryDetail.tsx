
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoryDetail Component
 *
 * Main component for displaying run details. Routes to either
 * LoadTestDetail or DesignRunDetail based on run type.
 */

import { AlertCircle, History, ArrowLeft } from "lucide-react";
import { useNavigationStore } from "@/stores";
import { useRunReportQuery } from "@/queries";
import { Button, Badge } from "@/components/ui";
import LoadTestDetail from "./LoadTestDetail";
import DesignRunDetail from "./DesignRunDetail";

export default function HistoryDetail() {
	const { selectedRunId, navigateToHistory } = useNavigationStore();

	// Use TanStack Query for run report
	const {
		data: report,
		isLoading: loading,
		error: queryError,
	} = useRunReportQuery(selectedRunId);

	const error = queryError instanceof Error ? queryError.message : null;

	// No run selected
	if (!selectedRunId) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
				<History className="w-12 h-12 opacity-50" />
				<div className="text-center">
					<p className="text-lg font-medium">No Run Selected</p>
					<p className="text-sm mt-1">
						Select a run from the sidebar to view details
					</p>
				</div>
			</div>
		);
	}

	// Loading state
	if (loading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
			</div>
		);
	}

	// Error state
	if (error || !report) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground space-y-4">
				<AlertCircle className="w-12 h-12 text-destructive/50" />
				<p>{error || "Report not found"}</p>
				<Button onClick={navigateToHistory}>Back to History</Button>
			</div>
		);
	}

	// Route to appropriate detail component based on run type
	const isDesignRun = report.metadata?.runType === "design";

	// Wrap detail views with a header containing back button
	return (
		<div className="flex flex-col h-full bg-background">
			{/* Header with Back Button */}
			<div className="border-b bg-card px-6 py-4 shrink-0">
				<div className="flex items-center gap-3">
					<Button variant="ghost" size="icon" onClick={navigateToHistory} className="shrink-0">
						<ArrowLeft className="w-5 h-5" />
					</Button>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2">
							<h1 className="text-lg font-semibold text-foreground truncate">
								{report.metadata?.requestUrl || (isDesignRun ? "Design Request" : "Load Test Report")}
							</h1>
							<Badge variant="outline" className="text-xs shrink-0">
								{isDesignRun ? "Design" : "Load Test"}
							</Badge>
						</div>
						<div className="flex items-center gap-2 mt-1">
							<span className="text-xs text-muted-foreground font-mono">{selectedRunId}</span>
							{report.metadata?.status && (
								<>
									<span className="text-xs text-muted-foreground">•</span>
									<Badge
										variant={
											report.metadata.status === "completed"
												? "default"
												: report.metadata.status === "failed"
													? "destructive"
													: "outline"
										}
										className={`text-xs capitalize ${report.metadata.status === "stopped"
												? "border-orange-500 text-orange-600 dark:text-orange-400"
												: ""
											}`}
									>
										{report.metadata.status}
									</Badge>
								</>
							)}
						</div>
					</div>
				</div>
			</div>
			{/* Detail Content */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{isDesignRun ? (
					<DesignRunDetail report={report} onBack={navigateToHistory} runId={selectedRunId} />
				) : (
					<LoadTestDetail report={report} onBack={navigateToHistory} runId={selectedRunId} />
				)}
			</div>
		</div>
	);
}
