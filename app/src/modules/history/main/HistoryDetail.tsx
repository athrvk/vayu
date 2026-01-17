
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

import { AlertCircle } from "lucide-react";
import { useNavigationStore } from "@/stores";
import { useRunReportQuery } from "@/queries";
import { Button } from "@/components/ui";
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
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<p>No run selected</p>
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

	if (isDesignRun) {
		return <DesignRunDetail report={report} onBack={navigateToHistory} runId={selectedRunId} />;
	}

	return <LoadTestDetail report={report} onBack={navigateToHistory} runId={selectedRunId} />;
}
