/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoryDetail Component
 *
 * The run tab. Routes to `DesignRunView` (an editable copy of the request that
 * was sent) or `LoadTestDetail` (the load-test report) by run type.
 *
 * It fetches the **run**, not only the report, because the two endpoints answer
 * different questions. `GET /run/:id/report` is a load-test aggregate: run it
 * against a design run and the percentiles all come from one sample, and
 * `metadata.configuration` is missing entirely - so it cannot say what a design
 * run's auth, scripts or redirect settings were. `GET /run/:id` can, and for a
 * design run it also carries the stored exchange. The report is therefore
 * fetched only for a load run.
 *
 * The header deliberately does not show the URL. `DesignRunView` renders the
 * builder's own URL bar directly below it, and two URL bars stacked one above
 * the other read as a bug. What stays is the run's identity, its type and its
 * status - the things the pane below does not repeat.
 */

import { History, ArrowLeft } from "lucide-react";
import { useRunQuery, useRunReportQuery } from "@/queries";
import { useTabsStore, useLayoutStore } from "@/stores";
import { Button, Badge } from "@/components/ui";
import { EmptyState, ErrorState, DetailSkeleton } from "@/components/shared";
import LoadTestDetail from "./LoadTestDetail";
import DesignRunView from "./DesignRunView";

export default function HistoryDetail() {
	const { openTabs, activeTabId } = useTabsStore();
	const { activateDrawerView } = useLayoutStore();

	// Get selectedRunId from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRunId = activeTab?.type === "run" ? activeTab.entityId : null;

	const navigateToHistory = () => activateDrawerView("history");

	const {
		data: run,
		isLoading: loadingRun,
		error: runError,
		refetch: refetchRun,
	} = useRunQuery(selectedRunId);

	const isDesignRun = run?.type === "design";

	// Only a load run has a report worth asking for.
	const {
		data: report,
		isLoading: loadingReport,
		error: reportError,
		refetch: refetchReport,
	} = useRunReportQuery(run && !isDesignRun ? selectedRunId : null);

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
	// detail pane: it holds the shape of the header that is about to land
	// instead of only saying "busy".
	if (loadingRun || (!isDesignRun && run && loadingReport)) {
		return <DetailSkeleton label="Loading run report" rows={5} />;
	}

	// Error state. Previously a hand-rolled pane whose only action was "Back to
	// History" - it walked the user away from the run instead of offering the
	// one thing that might work, a retry. A transient engine hiccup left no way
	// back in short of re-selecting the run.
	if (runError || !run) {
		const detail = runError instanceof Error ? runError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run"
				detail={detail ?? "The engine returned nothing for this run."}
				onRetry={() => void refetchRun()}
			/>
		);
	}

	if (!isDesignRun && (reportError || !report)) {
		const detail = reportError instanceof Error ? reportError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run"
				detail={detail ?? "The engine returned no report for this run."}
				onRetry={() => void refetchReport()}
			/>
		);
	}

	return (
		<div className="flex flex-col h-full bg-background">
			{/* Header with Back Button */}
			<div className="border-b border-border bg-card px-6 py-3 shrink-0">
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
					<div className="flex-1 min-w-0 flex items-center gap-2">
						<h1 className="text-sm font-semibold text-foreground shrink-0">
							{isDesignRun ? "Design run" : "Load test"}
						</h1>
						<span className="text-xs text-muted-foreground font-mono truncate">
							{selectedRunId}
						</span>
						<Badge
							variant={
								run.status === "completed"
									? "default"
									: run.status === "failed"
										? "destructive"
										: "outline"
							}
							/* "stopped" is a run status, so it takes the
							   --status-stopped family the sidebar's RunItem
							   already uses - not a raw orange that happens to
							   look the same. */
							className={`text-xs capitalize shrink-0 ${
								run.status === "stopped"
									? "border-status-stopped text-status-stopped-text"
									: ""
							}`}
						>
							{run.status}
						</Badge>
					</div>
				</div>
			</div>
			{/* Detail Content */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{isDesignRun ? (
					<DesignRunView run={run} />
				) : (
					<LoadTestDetail
						report={report!}
						onBack={navigateToHistory}
						runId={selectedRunId}
					/>
				)}
			</div>
		</div>
	);
}
