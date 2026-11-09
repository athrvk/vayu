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
import {
	canReattachLoadRun,
	dashboardRunEnding,
	isDashboardRunLive,
	runningRunSentence,
	runningRunTab,
	useDashboardStore,
	useLayoutStore,
	useTabsStore,
	useToastStore,
} from "@/stores";
import { apiService, loadTestService } from "@/services";
import { EmptyState, Callout, TabBreadcrumb, reportOutcome } from "@/components/shared";
import { Button } from "@/components/ui";
import LoadTestDetail from "@/modules/history/main/LoadTestDetail";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import { DashboardHeader, MetricsView } from "./components";
import { useCollectionRunTarget } from "./hooks/useCollectionRunTarget";
import { TIMING } from "@/config/timing";
import { durationSeconds } from "@/constants/load-test";
import { isRunInProgress, isRunTerminal } from "@/lib/run-status";
import type { DisplayMetrics } from "./types";

/** The lost-stream callout's body for a run whose report never stopped saying running. */
const STILL_RUNNING_MESSAGE =
	"The stream closed, but Vayu's engine still reports this load test as running.";

/**
 * The report kept saying the run is live after every attempt. A live run ends
 * on the lost-stream callout: the engine is still generating load, so the pill
 * and Stop stay, and Reconnect is the way on. A run whose Stop the engine
 * confirmed is not raised back to live; its fetch failed like any other, and
 * Retry stays.
 */
function giveUpOnLiveReport(runId: string): void {
	const { phase, streamLost, reportFailed } = useDashboardStore.getState();
	if (isDashboardRunLive(phase)) streamLost(runId, STILL_RUNNING_MESSAGE);
	else reportFailed(runId, "Vayu's engine still reports this run as running.");
}

/**
 * What the engine's answer to Stop means for the dashboard (#3367), by the
 * answer's `status` (`load_stop_status` in `runs.cpp`):
 *
 * - `stopped`: the Stop took effect. Release the stream, which posts the
 *   "stopped" notification, and await the report as stopped.
 * - `completed` / `failed`: the run had finished when Stop arrived. The stream
 *   or the report fetch settles it with its real status, so `stopMonitoring`
 *   (an unconditional "stopped" notification) stays out of it
 *   (`settleOnStoredReport` is the precedent); only the late Stop is recorded.
 * - `running`, or a status this client does not know: the strategy returned on
 *   its own and the run ends by its own verdict. Nothing changes.
 */
function applyStopAnswer(runId: string, status: string): void {
	const store = useDashboardStore.getState();
	if (status === "stopped") {
		loadTestService.stopMonitoring();
		store.stopRun(runId);
		return;
	}
	if (isRunTerminal(status)) store.noteLateStop(runId);
}

/**
 * Re-attach the stream to the dashboard's run, unless it is attached already
 * or a collection run holds it (`canReattachLoadRun`, #3351): taking the
 * stream would leave that run with no live view. Unasked, so no toast; the run
 * stays on the lost-stream callout, whose Reconnect says why.
 */
function reattachOnMount(runId: string): void {
	if (loadTestService.isMonitoring(runId) || !canReattachLoadRun().ok) return;
	loadTestService.startMonitoring(runId);
}

export default function LoadTestDashboard() {
	const showToast = useToastStore((state) => state.showToast);
	const openTab = useTabsStore((state) => state.openTab);
	const currentRunId = useDashboardStore((s) => s.currentRunId);
	// Changes identity only on a transition, never on a tick.
	const phase = useDashboardStore((s) => s.phase);
	const currentMetrics = useDashboardStore((s) => s.currentMetrics);
	const historicalMetrics = useDashboardStore((s) => s.historicalMetrics);
	const isStopping = useDashboardStore((s) => s.isStopping);
	const loadTestConfig = useDashboardStore((s) => s.loadTestConfig);
	const requestInfo = useDashboardStore((s) => s.requestInfo);
	const stopArrivedLate = useDashboardStore((s) => s.stopArrivedLate);
	const setFinalReport = useDashboardStore((s) => s.setFinalReport);
	const reportFailed = useDashboardStore((s) => s.reportFailed);
	const retryReport = useDashboardStore((s) => s.retryReport);
	const setStopping = useDashboardStore((s) => s.setStopping);

	const live = isDashboardRunLive(phase);
	const awaitingReport = phase.phase === "awaitingReport";

	// A collection load run has no URL; this is what the header says instead.
	const { collectionName, stepCount } = useCollectionRunTarget(currentRunId);

	// Track whether we're loading the report
	const [isLoadingReport, setIsLoadingReport] = useState(false);
	// Failures and still-running reports count against the same cap as empty
	// reports, and the last one leaves `awaitingReport` (`reportError`, or
	// `streamLost` for a run still going): a swallowed throw once re-ran the
	// fetch forever, silently, showing an empty dashboard the whole time.
	const loadAttemptRef = useRef(0);
	const hasCheckedStatus = useRef(false);

	// Check run status on mount - handles case where user navigated away and returned
	// Also ensures SSE reconnection if service lost connection
	useEffect(() => {
		if (currentRunId && live && !hasCheckedStatus.current) {
			hasCheckedStatus.current = true;

			// Check if the run is still actually running on the backend
			apiService
				.getRunReport(currentRunId)
				.then((report) => {
					if (report?.metadata?.status) {
						const status = report.metadata.status;
						if (isRunTerminal(status)) {
							// Run finished while we were away - update state
							setFinalReport(currentRunId, report);
							loadTestService.settleOnStoredReport(currentRunId, report);
						} else {
							reattachOnMount(currentRunId);
						}
					}
				})
				.catch((err) => {
					console.error("Failed to check run status:", err);
					// Try to reconnect anyway
					reattachOnMount(currentRunId);
				});
		}

		// Reset the check flag when currentRunId changes
		if (!currentRunId) {
			hasCheckedStatus.current = false;
		}
	}, [currentRunId, live, setFinalReport]);

	// Converge on the stored report while the run awaits it, with a delay and a
	// capped retry (#1925). Usually `handleClose` lands the report inside the
	// first delay and this fetches nothing. A lost stream means the run is still
	// going and Reconnect is the way on, so this waits for that, and does not
	// re-arm itself out of it. Retry returns the phase to `awaitingReport`,
	// which re-arms this.
	useEffect(() => {
		if (!currentRunId || !awaitingReport || isLoadingReport) return;
		// Longer initial delay to allow database writes to complete
		// This helps avoid "database is locked" issues
		const delay =
			loadAttemptRef.current === 0
				? TIMING.REPORT_INITIAL_DELAY_MS
				: TIMING.REPORT_RETRY_DELAY_MS;

		// Spend one attempt, or at the cap reset the count and give up as told.
		const retryOr = (giveUp: () => void) => {
			if (loadAttemptRef.current < TIMING.REPORT_MAX_ATTEMPTS) {
				loadAttemptRef.current++;
				return;
			}
			loadAttemptRef.current = 0;
			giveUp();
		};

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
					retryOr(() => giveUpOnLiveReport(currentRunId));
					return;
				}
				if (!report) return;
				const isValidReport =
					report.summary?.totalRequests > 0 ||
					report.summary?.summaryMissing === true ||
					historicalMetrics.length === 0;
				if (isValidReport) {
					setFinalReport(currentRunId, report);
					loadAttemptRef.current = 0;
					return;
				}
				retryOr(() => {
					console.warn("Report still has zero data after retries; showing it as stored");
					setFinalReport(currentRunId, report);
				});
			} catch (err) {
				retryOr(() =>
					reportFailed(
						currentRunId,
						err instanceof Error ? err.message : "Couldn't load the run report"
					)
				);
			} finally {
				setIsLoadingReport(false);
			}
		}, delay);

		return () => clearTimeout(timeoutId);
	}, [
		currentRunId,
		awaitingReport,
		isLoadingReport,
		setFinalReport,
		reportFailed,
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
				setStopping(currentRunId, true);
				try {
					const { status } = await apiService.stopRun(currentRunId);
					applyStopAnswer(currentRunId, status);
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
					setStopping(currentRunId, false);
				}
			}
		},
		[currentRunId, setStopping, showToast]
	);

	// While a collection run streams, Reconnect would take its stream, so it
	// opens that run and says why instead, as the builder's Load test does.
	const handleReconnect = useCallback(() => {
		if (!currentRunId) return;
		const gate = canReattachLoadRun();
		if (!gate.ok) {
			openTab(runningRunTab(gate.running));
			showToast(runningRunSentence(gate.running), "warning");
			return;
		}
		loadTestService.startMonitoring(currentRunId);
	}, [currentRunId, openTab, showToast]);

	// A finished run - completed, failed or stopped - is shown as History's own
	// report once its report is here, so the run reads the same now and later
	// (#1932, #2136, #2220). Until then (a stopped run's report still on its way,
	// or a fetch that failed) it keeps the live view, which carries the Retry.
	const report = phase.phase === "finished" ? phase.report : null;
	const endedAs = dashboardRunEnding(phase);

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
			{ id: "run", label: `Live ${RUN_TYPE_NAME.load.toLowerCase()}` },
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
	 * One notice slot for both failures the dashboard can hit. Each is a phase
	 * of its own, so the two never stand together, and a report on screen has
	 * nothing left to retry or reconnect.
	 */
	const notices = (phase.phase === "streamLost" || phase.phase === "reportError") && (
		<div className="enter-fade px-5 pt-3 shrink-0">
			{phase.phase === "streamLost" ? (
				<Callout
					severity="blocking"
					title="Lost the live metrics stream"
					action={
						<Button variant="outline" size="sm" onClick={handleReconnect}>
							Reconnect
						</Button>
					}
				>
					{phase.message} Anything already received is still shown below.
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
								retryReport(currentRunId);
							}}
						>
							Retry
						</Button>
					}
				>
					{phase.message} The live metrics below are whatever was captured before the run
					finished.
				</Callout>
			)}
		</div>
	);

	if (report) {
		return (
			<div className="flex-1 flex flex-col overflow-hidden">
				{/* Identity and Export only: the report below carries the crumb, the
				    URL, the configuration and the verdict banner. */}
				<DashboardHeader
					live={live}
					endedAs={endedAs}
					isStopping={isStopping}
					onStop={handleStop}
					outcome={judgement?.outcome}
					comment={report.metadata?.configuration?.comment}
					exportRunId={currentRunId}
					exportRequestUrl={report.metadata?.requestUrl}
					exportRequestMethod={report.metadata?.requestMethod}
				/>
				{stopArrivedLate && (
					<div className="enter-fade px-5 pt-3 shrink-0">
						<Callout severity="info">
							The run had already finished when Stop arrived.
						</Callout>
					</div>
				)}
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
				live={live}
				endedAs={endedAs}
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
					runDurationSeconds={durationSeconds(loadTestConfig?.duration) ?? undefined}
					rampConfig={rampConfig}
				/>
			</div>
		</div>
	);
}

// Re-export types
export type { DisplayMetrics } from "./types";
