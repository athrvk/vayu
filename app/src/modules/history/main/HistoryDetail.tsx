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

import { History, ArrowLeft } from "lucide-react";
import { useRunReportQuery } from "@/queries";
import { useTabsStore, useLayoutStore } from "@/stores";
import { Button, Badge } from "@/components/ui";
import { TruncatedText, EmptyState, ErrorState, DetailSkeleton } from "@/components/shared";
import LoadTestDetail from "./LoadTestDetail";
import DesignRunDetail from "./DesignRunDetail";

export default function HistoryDetail() {
	const { openTabs, activeTabId } = useTabsStore();
	const { activateDrawerView } = useLayoutStore();

	// Get selectedRunId from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRunId = activeTab?.type === "run" ? activeTab.entityId : null;

	const navigateToHistory = () => activateDrawerView("history");

	// Use TanStack Query for run report
	const {
		data: report,
		isLoading: loading,
		error: queryError,
		refetch,
	} = useRunReportQuery(selectedRunId);

	const error = queryError instanceof Error ? queryError.message : null;

	// No run selected
	if (!selectedRunId) {
		return (
			<EmptyState
				icon={History}
				title="No run selected"
				description="Pick a run from the sidebar to see its results."
			/>
		);
	}

	// Loading state. A skeleton rather than a spinner, matching every other
	// detail pane: it holds the shape of the report header that is about to
	// land instead of only saying "busy".
	if (loading) {
		return <DetailSkeleton label="Loading run report" rows={5} />;
	}

	// Error state. Previously a hand-rolled pane whose only action was "Back to
	// History" — it walked the user away from the run instead of offering the
	// one thing that might work, a retry. A transient engine hiccup left no way
	// back in short of re-selecting the run.
	if (error || !report) {
		return (
			<ErrorState
				title="Couldn't load this run"
				detail={error ?? "The engine returned no report for this run."}
				onRetry={() => void refetch()}
			/>
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
					<Button
						variant="ghost"
						size="icon"
						onClick={navigateToHistory}
						className="shrink-0"
						aria-label="Back to history"
					>
						<ArrowLeft className="w-5 h-5" />
					</Button>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2">
							<TruncatedText
								as="h1"
								className="text-lg font-semibold text-foreground"
							>
								{report.metadata?.requestUrl ||
									(isDesignRun ? "Design Request" : "Load Test Report")}
							</TruncatedText>
							<Badge variant="outline" className="text-xs shrink-0">
								{isDesignRun ? "Design" : "Load Test"}
							</Badge>
						</div>
						<div className="flex items-center gap-2 mt-1">
							<span className="text-xs text-muted-foreground font-mono">
								{selectedRunId}
							</span>
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
										/* "stopped" is a run status, so it takes the
										   --status-stopped family the sidebar's RunItem
										   already uses — not a raw orange that happens to
										   look the same. */
										className={`text-xs capitalize ${
											report.metadata.status === "stopped"
												? "border-status-stopped text-status-stopped-text"
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
					<DesignRunDetail
						report={report}
						onBack={navigateToHistory}
						runId={selectedRunId}
					/>
				) : (
					<LoadTestDetail
						report={report}
						onBack={navigateToHistory}
						runId={selectedRunId}
					/>
				)}
			</div>
		</div>
	);
}
