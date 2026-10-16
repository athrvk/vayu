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
 * A running load test's live metrics, and the same run's report once it ends.
 *
 * Architecture:
 * - DashboardHeader: Title, status, stop button
 * - MetricsView: Live metrics, charts
 * - LoadTestDetail: the finished run's report, the component History renders
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardStore, useLayoutStore, useToastStore } from "@/stores";
import { apiService, loadTestService } from "@/services";
import { EmptyState, Callout, TabBreadcrumb, reportOutcome } from "@/components/shared";
import { Button } from "@/components/ui";
import LoadTestDetail from "@/modules/history/main/LoadTestDetail";
import { DashboardHeader, MetricsView } from "./components";
import { useCollectionRunTarget } from "./hooks/useCollectionRunTarget";
import { TIMING } from "@/config/timing";
import { durationSeconds } from "@/constants/load-test";
import { isRunInProgress } from "@/lib/run-status";
import type { DisplayMetrics } from "./types";

export default function LoadTestDashboard() {
	const showToast = useToastStore((state) => state.showToast);
	const currentRunId = useDashboardStore((s) => s.currentRunId);
	const mode = useDashboardStore((s) => s.mode);
	const isStreaming = useDashboardStore((s) => s.isStreaming);
	const currentMetrics = useDashboardStore((s) => s.currentMetrics);
	const historicalMetrics = useDashboardStore((s) => s.historicalMetrics);
	const finalReport = useDashboardStore((s) => s.finalReport);
	const isStopping = useDashboardStore((s) => s.isStopping);
	const loadTestConfig = useDashboardStore((s) => s.loadTestConfig);
	const requestInfo = useDashboardStore((s) => s.requestInfo);
	const stopRun = useDashboardStore((s) => s.stopRun);
	const setFinalReport = useDashboardStore((s) => s.setFinalReport);
	const setStopping = useDashboardStore((s) => s.setStopping);
	// Written by the SSE layer on a connection failure and, until now, read
	// by nothing - so a dead metrics stream looked like a run with no data.
	const streamError = useDashboardStore((s) => s.error);
	const setStreamError = useDashboardStore((s) => s.setError);

	// A collection load run has no URL; this is what the header says instead.
	const { collectionName, stepCount } = useCollectionRunTarget(currentRunId);

	// Track whether we're loading the report
	const [isLoadingReport, setIsLoadingReport] = useState(false);
	/**
	 * Set once the report fetch has failed as many times as it is allowed to.
	 *
	 * Before this, a throw was swallowed: the `try`/`finally` below had no
	 * `catch`, so `isLoadingReport` went back to false, that is an effect
	 * dependency, the guard `!finalReport && !isLoadingReport` became true again,
	 * and the fetch re-ran. `loadAttemptRef` was only incremented on the
	 * zero-data path, never on failure, so the cap never engaged - a persistent
	 * failure (engine down) retried forever, silently, showing an empty
	 * dashboard the whole time.
	 */
	const [reportError, setReportError] = useState<string | null>(null);
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
							setFinalReport(report);
							loadTestService.stopMonitoring();
						} else if (!loadTestService.isMonitoring(currentRunId)) {
							// Run is still running but service is not connected - reconnect
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

	// Converge on the stored report once the stream has stopped, with a delay
	// and a capped retry. Keyed on the stream, not on `mode`: a run whose stream
	// ended is still in `running` until a final report arrives, and that is the
	// state this has to resolve (#1925). Usually `handleClose` lands the report
	// inside the first delay and this fetches nothing. A stream error means the
	// run is still going and Reconnect is the way on, so this waits for that.
	// `reportError` is a dependency so that Retry, which clears it, re-arms this.
	useEffect(() => {
		if (!currentRunId || isStreaming || finalReport || streamError) return;
		if (isLoadingReport || reportError) return;
		// Longer initial delay to allow database writes to complete
		// This helps avoid "database is locked" issues
		const delay =
			loadAttemptRef.current === 0
				? TIMING.REPORT_INITIAL_DELAY_MS
				: TIMING.REPORT_RETRY_DELAY_MS;

		const timeoutId = setTimeout(async () => {
			setIsLoadingReport(true);
			try {
				const report = await apiService.getRunReport(currentRunId);
				// Read live, not from the closure: a run started during the fetch
				// must not be finalised with this one's report.
				if (useDashboardStore.getState().currentRunId !== currentRunId) return;
				// Counted against the cap like a failure: the store would refuse it,
				// and accepting it here would re-fetch on every pass with no end.
				if (isRunInProgress(report?.metadata?.status)) {
					throw new Error("Vayu's engine still reports this run as running.");
				}
				if (report) {
					const isValidReport =
						report.summary?.totalRequests > 0 || historicalMetrics.length === 0;

					if (isValidReport) {
						setFinalReport(report);
						loadAttemptRef.current = 0;
					} else if (loadAttemptRef.current < TIMING.REPORT_MAX_ATTEMPTS) {
						loadAttemptRef.current++;
						setIsLoadingReport(false);
					} else {
						console.warn(
							"Report still has zero data after retries; showing it as stored"
						);
						setFinalReport(report);
						loadAttemptRef.current = 0;
					}
				}
			} catch (err) {
				// Count failures against the same cap as empty reports, so a
				// persistent error stops rather than looping.
				if (loadAttemptRef.current < TIMING.REPORT_MAX_ATTEMPTS) {
					loadAttemptRef.current++;
				} else {
					loadAttemptRef.current = 0;
					setReportError(
						err instanceof Error ? err.message : "Couldn't load the run report"
					);
				}
			} finally {
				setIsLoadingReport(false);
			}
		}, delay);

		return () => clearTimeout(timeoutId);
	}, [
		currentRunId,
		isStreaming,
		finalReport,
		streamError,
		isLoadingReport,
		reportError,
		setFinalReport,
		historicalMetrics.length,
	]);

	// useCallback, not a plain arrow: this is DashboardHeader's onStop prop, and
	// DashboardHeader is memo'd below - a fresh function identity every tick
	// would defeat that memo the same way an inline object prop would (#1714).
	//
	// `attemptStop` is a named function expression, not the useCallback arrow
	// itself, so the retry toast's `onClick` can call it by name: a `const`
	// referencing itself inside its own initializer trips
	// react-hooks/immutability (the value "is accessed before it is
	// declared"), where a named function's self-reference is ordinary,
	// hoisted-within-itself JavaScript.
	const handleStop = useCallback(
		async function attemptStop() {
			if (currentRunId) {
				setStopping(true);
				try {
					await apiService.stopRun(currentRunId);
					loadTestService.stopMonitoring();
					stopRun();
				} catch (error) {
					// The button re-enables and the run keeps streaming, so without
					// this the click is indistinguishable from one that did nothing.
					// A toast rather than the report Callout: this is the outcome of
					// an action the user just took, not a state of the page.
					console.error("Failed to stop run:", error);
					showToast({
						message: error instanceof Error ? error.message : "Couldn't stop the run",
						variant: "error",
						// The run is still generating load, so the retry is the whole
						// point of telling them. Chasing the Stop button back down in
						// the header is a worse version of the same click.
						action: {
							label: "Try again",
							altText: "Try stopping the run again",
							onClick: () => void attemptStop(),
						},
					});
				} finally {
					setStopping(false);
				}
			}
		},
		[currentRunId, setStopping, stopRun, showToast]
	);

	// A finished run - completed, failed or stopped - is shown as History's own
	// report once its report is here, so the run reads the same now and later
	// (#1932, #2136, #2220). Until then (a stopped run's report still on its way,
	// or a fetch that failed) it keeps the live view, which carries the Retry.
	const report =
		mode === "completed" || mode === "failed" || mode === "stopped" ? finalReport : null;

	// The header pill's half of the verdict (#2130); the report draws the banner.
	const judgement = useMemo(() => reportOutcome(report), [report]);

	const lastTick =
		historicalMetrics.length > 0 ? historicalMetrics[historicalMetrics.length - 1] : null;
	const displayMetrics: DisplayMetrics | null = currentMetrics || lastTick;
	const elapsedDuration = lastTick ? lastTick.elapsed_seconds * 1000 : 0;

	// Memoised: MetricsView is memo'd, and a fresh object per tick would defeat it.
	const rampConfig = useMemo(
		() => ({
			rampUpDurationSeconds: durationSeconds(loadTestConfig?.rampUpDuration) ?? undefined,
			startConcurrency: loadTestConfig?.startConcurrency,
			targetConcurrency: loadTestConfig?.concurrency,
		}),
		[loadTestConfig]
	);

	const revealDrawerView = useLayoutStore((state) => state.revealDrawerView);
	const crumbs = useMemo(
		() => [
			{ id: "history", label: "History", onSelect: () => revealDrawerView("history") },
			// The finished run's crumb is the report's own ("Load test run").
			{ id: "run", label: "Live load test" },
		],
		[revealDrawerView]
	);

	// Empty state - placed after all hooks so the hook call order stays stable
	// across renders (Rules of Hooks); the memos above are null-safe with no run.
	if (!currentRunId) {
		return (
			<EmptyState
				title="No active load test"
				action={
					<Button variant="link" onClick={() => revealDrawerView("history")}>
						View past runs
					</Button>
				}
			/>
		);
	}

	/*
	 * One notice slot for both failures the dashboard can hit. The stream error
	 * comes first: without live metrics the page has nothing to show, whereas a
	 * missing report still leaves whatever was captured. Only the live view shows
	 * them: a report on screen has nothing left to retry or reconnect, and a stream
	 * error can outlive the run when a remount's status check lands the report.
	 */
	const reportNotice = report ? null : reportError;
	const notices = (streamError || reportNotice) && (
		<div className="enter-fade px-5 pt-3 shrink-0">
			{streamError ? (
				<Callout
					severity="blocking"
					title="Lost the live metrics stream"
					action={
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setStreamError(null);
								loadTestService.startMonitoring(currentRunId);
							}}
						>
							Reconnect
						</Button>
					}
				>
					{streamError} Anything already received is still shown below.
				</Callout>
			) : (
				<Callout
					severity="blocking"
					title="Couldn't load the run report"
					action={
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								loadAttemptRef.current = 0;
								setReportError(null);
							}}
						>
							Retry
						</Button>
					}
				>
					{reportNotice} The live metrics below are whatever was captured before the run
					finished.
				</Callout>
			)}
		</div>
	);

	if (report) {
		return (
			<div className="flex-1 flex flex-col overflow-hidden">
				{/* Identity only: the report below carries the crumb, the URL, the
				    configuration and the verdict banner. */}
				<DashboardHeader
					mode={mode}
					isStreaming={isStreaming}
					isStopping={isStopping}
					onStop={handleStop}
					outcome={judgement?.outcome}
					comment={report.metadata?.configuration?.comment}
				/>
				<div className="flex-1 min-h-0 overflow-hidden">
					<LoadTestDetail key={currentRunId} report={report} runId={currentRunId} />
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Compact single-row header */}
			<DashboardHeader
				mode={mode}
				isStreaming={isStreaming}
				isStopping={isStopping}
				onStop={handleStop}
				requestUrl={requestInfo?.url}
				requestMethod={requestInfo?.method}
				collectionName={collectionName}
				stepCount={stepCount}
				comment={loadTestConfig?.comment}
				elapsedDuration={elapsedDuration}
				configuration={loadTestConfig ?? undefined}
			/>

			{/*
			 * Where this screen sits (#1691). The dashboard is reached from a run in
			 * History or from starting a load test, and nothing on it used to say
			 * so - the header names the run, not the place. "History" reveals the
			 * run list rather than toggling it, so a crumb pressed from here always
			 * shows the list it points at.
			 */}
			<TabBreadcrumb label="Run location" crumbs={crumbs} className="bg-transparent px-5" />

			{notices}

			<div className="flex-1 overflow-auto bg-background">
				<MetricsView
					metrics={displayMetrics}
					historicalMetrics={historicalMetrics}
					targetRps={loadTestConfig?.targetRps}
					concurrency={loadTestConfig?.concurrency}
					mode={loadTestConfig?.mode}
					rampConfig={rampConfig}
				/>
			</div>
		</div>
	);
}

// Re-export types
export type { DashboardMode, DisplayMetrics } from "./types";
