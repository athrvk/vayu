
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestDashboard - Main Container Component
 *
 * Location: Main content area only
 *
 * Displays real-time metrics and results for load tests.
 *
 * Architecture:
 * - DashboardHeader: Title, status, stop button
 * - RunMetadata: API endpoint, config, timing
 * - MetricsView: Live metrics, charts
 * - RequestResponseView: Status codes, errors, timing breakdown
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Eye } from "lucide-react";
import { useDashboardStore } from "@/stores";
import { apiService, loadTestService } from "@/services";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { DashboardHeader, RunMetadata, MetricsView, RequestResponseView } from "./components";
import type { DashboardView, DisplayMetrics } from "./types";

export default function LoadTestDashboard() {
	const {
		currentRunId,
		mode,
		isStreaming,
		currentMetrics,
		historicalMetrics,
		finalReport,
		activeView,
		isStopping,
		loadTestConfig,
		requestInfo,
		setActiveView,
		stopRun,
		setFinalReport,
		setStopping,
	} = useDashboardStore();

	// Track whether we're loading the report
	const [isLoadingReport, setIsLoadingReport] = useState(false);
	const loadAttemptRef = useRef(0);
	const hasCheckedStatus = useRef(false);

	// Check run status on mount - handles case where user navigated away and returned
	// Also ensures SSE reconnection if service lost connection
	useEffect(() => {
		if (currentRunId && mode === "running" && !hasCheckedStatus.current) {
			hasCheckedStatus.current = true;

			// Check if the run is still actually running on the backend
			apiService
				.getRunReport(currentRunId)
				.then((report) => {
					if (report?.metadata?.status) {
						const status = report.metadata.status;
						if (status === "completed" || status === "stopped" || status === "failed") {
							// Run finished while we were away - update state
							console.log(
								`Run ${currentRunId} finished while away (status: ${status})`
							);
							setFinalReport(report);
							loadTestService.stopMonitoring();
						} else if (!loadTestService.isMonitoring(currentRunId)) {
							// Run is still running but service is not connected - reconnect
							console.log(`Reconnecting to run ${currentRunId}`);
							loadTestService.startMonitoring(currentRunId);
						}
					}
				})
				.catch((err) => {
					console.error("Failed to check run status:", err);
					// Try to reconnect anyway if not monitoring
					if (!loadTestService.isMonitoring(currentRunId)) {
						loadTestService.startMonitoring(currentRunId);
					}
				});
		}

		// Reset the check flag when currentRunId changes
		if (!currentRunId) {
			hasCheckedStatus.current = false;
		}
	}, [currentRunId, mode, setFinalReport]);

	// Detect when streaming stops (test completed naturally) and trigger report fetch
	useEffect(() => {
		if (mode === "running" && !isStreaming && currentRunId && !finalReport) {
			// Streaming stopped but mode is still "running" - the test completed naturally
			// Fetch the final report to get the actual completion status
			console.log("Streaming stopped, fetching final report...");
			setIsLoadingReport(true);
			apiService
				.getRunReport(currentRunId)
				.then((report) => {
					if (report) {
						setFinalReport(report);
					}
				})
				.catch((err) => {
					console.error("Failed to fetch final report:", err);
				})
				.finally(() => {
					setIsLoadingReport(false);
				});
		}
	}, [mode, isStreaming, currentRunId, finalReport, setFinalReport]);

	// Load final report when test completes (with delay and retry)
	useEffect(() => {
		if (
			(mode === "completed" || mode === "stopped") &&
			currentRunId &&
			!finalReport &&
			!isLoadingReport
		) {
			// Longer initial delay to allow database writes to complete
			// This helps avoid "database is locked" issues
			const delay = loadAttemptRef.current === 0 ? 3000 : 1000;

			const timeoutId = setTimeout(async () => {
				setIsLoadingReport(true);
				try {
					const report = await apiService.getRunReport(currentRunId);
					if (report) {
						const isValidReport =
							report.summary?.totalRequests > 0 || historicalMetrics.length === 0;

						if (isValidReport) {
							setFinalReport(report);
							loadAttemptRef.current = 0;
						} else if (loadAttemptRef.current < 5) {
							console.log(
								`Report has zero data, retrying... (attempt ${loadAttemptRef.current + 1})`
							);
							loadAttemptRef.current++;
							setIsLoadingReport(false);
						} else {
							console.warn(
								"Report still has zero data after retries, using historical metrics"
							);
							setFinalReport(report);
							loadAttemptRef.current = 0;
						}
					}
				} finally {
					setIsLoadingReport(false);
				}
			}, delay);

			return () => clearTimeout(timeoutId);
		}
	}, [
		mode,
		currentRunId,
		finalReport,
		isLoadingReport,
		setFinalReport,
		historicalMetrics.length,
	]);

	const handleStop = async () => {
		if (currentRunId) {
			setStopping(true);
			try {
				await apiService.stopRun(currentRunId);
				loadTestService.stopMonitoring();
				stopRun();
			} catch (error) {
				console.error("Failed to stop run:", error);
			} finally {
				setStopping(false);
			}
		}
	};

	// Empty state
	if (!currentRunId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<p>No active load test</p>
			</div>
		);
	}

	// Compute derived state
	const lastHistoricalMetrics = useMemo(() => {
		return historicalMetrics.length > 0
			? historicalMetrics[historicalMetrics.length - 1]
			: null;
	}, [historicalMetrics]);

	const historicalTotalRequests = lastHistoricalMetrics?.requests_completed ?? 0;
	const hasValidReportData = finalReport && finalReport.summary?.totalRequests > 0;

	const displayMetrics = useMemo((): DisplayMetrics | null => {
		if (mode === "completed" && finalReport) {
			if (finalReport.summary.totalRequests === 0 && historicalTotalRequests > 0) {
				return lastHistoricalMetrics as DisplayMetrics;
			}
			return {
				requests_completed: finalReport.summary.totalRequests,
				requests_failed: finalReport.summary.failedRequests,
				current_rps: finalReport.summary.avgRps,
				latency_p50_ms: finalReport.latency.p50,
				latency_p95_ms: finalReport.latency.p95,
				latency_p99_ms: finalReport.latency.p99,
				avg_latency_ms: finalReport.latency.avg,
				bytes_sent: 0,
				bytes_received: 0,
			};
		}
		return (currentMetrics || lastHistoricalMetrics) as DisplayMetrics | null;
	}, [mode, finalReport, currentMetrics, lastHistoricalMetrics, historicalTotalRequests]);

	const runMetadata = hasValidReportData ? finalReport?.metadata : null;

	// Build configuration from stored config or final report
	// This ensures config is shown during live streaming, not just after report loads
	const displayConfiguration = useMemo(() => {
		if (runMetadata?.configuration) {
			return runMetadata.configuration;
		}
		if (loadTestConfig) {
			return {
				mode: loadTestConfig.mode,
				duration: loadTestConfig.duration,
				targetRps: loadTestConfig.targetRps,
				concurrency: loadTestConfig.concurrency,
				comment: loadTestConfig.comment,
			};
		}
		return undefined;
	}, [runMetadata?.configuration, loadTestConfig]);

	// Build request info from stored info or final report
	const displayRequestUrl = runMetadata?.requestUrl ?? requestInfo?.url;
	const displayRequestMethod = runMetadata?.requestMethod ?? requestInfo?.method;

	// Calculate times
	const historicalStartTime =
		historicalMetrics.length > 0 ? historicalMetrics[0].timestamp : null;
	const historicalEndTime =
		mode === "completed" && historicalMetrics.length > 0
			? historicalMetrics[historicalMetrics.length - 1].timestamp
			: null;

	const startTime =
		runMetadata?.startTime &&
		(!historicalStartTime || runMetadata.startTime <= historicalStartTime)
			? runMetadata.startTime
			: historicalStartTime;

	const endTime =
		runMetadata?.endTime && runMetadata.endTime > 0 ? runMetadata.endTime : historicalEndTime;

	const elapsedDuration = useMemo(() => {
		// Use accurate testDuration from report if available (in seconds, convert to ms)
		if (mode === "completed" && finalReport?.summary?.testDuration) {
			return finalReport.summary.testDuration * 1000;
		}
		if (historicalMetrics.length > 0) {
			const lastMetric = historicalMetrics[historicalMetrics.length - 1];
			return lastMetric.elapsed_seconds * 1000;
		}
		return startTime && endTime ? endTime - startTime : 0;
	}, [mode, finalReport?.summary?.testDuration, historicalMetrics, startTime, endTime]);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="p-4 border-b bg-card">
				<DashboardHeader
					runId={currentRunId}
					mode={mode}
					isStreaming={isStreaming}
					isStopping={isStopping}
					onStop={handleStop}
				/>

				{/* Run Metadata */}
				<RunMetadata
					requestUrl={displayRequestUrl}
					requestMethod={displayRequestMethod}
					startTime={startTime ?? undefined}
					endTime={endTime ?? undefined}
					mode={mode}
					elapsedDuration={elapsedDuration}
					setupOverhead={finalReport?.summary?.setupOverhead}
					configuration={displayConfiguration}
				/>

				{/* View Toggle */}
				<Tabs value={activeView} onValueChange={(v) => setActiveView(v as DashboardView)}>
					<TabsList>
						<TabsTrigger value="metrics" className="gap-2">
							<BarChart3 className="w-4 h-4" />
							Metrics Dashboard
						</TabsTrigger>
						<TabsTrigger value="request-response" className="gap-2">
							<Eye className="w-4 h-4" />
							Request/Response
						</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-6 bg-muted/30">
				{activeView === "metrics" ? (
					<MetricsView
						metrics={displayMetrics}
						historicalMetrics={historicalMetrics}
						isCompleted={mode === "completed"}
					/>
				) : (
					<RequestResponseView report={finalReport} />
				)}
			</div>
		</div>
	);
}

// Re-export types
export type { DashboardMode, DashboardView, DisplayMetrics } from "./types";
