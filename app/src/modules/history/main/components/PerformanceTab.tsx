/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * PerformanceTab Component
 *
 * Displays latency distribution, rate control metrics, and time-series charts.
 */

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { isRateLimitedRun, hasPercentileSignal } from "@/modules/dashboard/utils/metricsTransforms";
import {
	LatencyPercentilesChart,
	ResponseTimeVsConcurrencyChart,
	CHART_SYNC,
} from "@/modules/dashboard/components/charts/uplot";
import { PhasePercentiles } from "@/modules/dashboard/components/charts/PhasePercentiles";
import LatencyMetric from "./LatencyMetric";
import MonitorSummary from "./MonitorSummary";
import HistoricalChartsSection from "./HistoricalChartsSection";
import { useHostSleeps } from "@/stores/host-sleep-store";
import type { PerformanceTabProps } from "../../types";

export default function PerformanceTab({
	report,
	runId,
	derived,
	anomalies,
	timeSeries,
	monitorSamples,
	isLoadingSeries,
	isFetchingMore,
	progress,
}: PerformanceTabProps) {
	// The run's own record of the host sleeping under it (#1357), read here by
	// run id rather than drilled from `LoadTestDetail`: Overview states them and
	// this tab marks them, and neither derives anything the other must match.
	const hostSleeps = useHostSleeps(runId);
	// Windowed per-tick percentiles now persist for completed runs (W1), so the
	// history percentile chart / scatter can render the same views as the live
	// dashboard. Mirror MetricsView's split: ramp_up → response-time-vs-concurrency
	// scatter (capacity elbow), other modes → percentiles-over-time.
	//
	// The gate asks a predicate, not a series (#1190, the rule #1152 wrote into
	// modules/dashboard/README.md). The chart below builds the percentile series
	// from this same array, so building it here too transformed a loaded run's
	// ticks twice on every render of the tab. `hasPercentileSignal` reads every
	// tick rather than each bucket's last-write-wins sample, so it can only be
	// more permissive than the `.some((d) => d.p99 > 0)` it replaces - and the
	// chart's own two-point guard still decides whether anything is drawn.
	//
	// Memoised despite returning a boolean, as MetricsView does: the predicate
	// stops at the first tick carrying a p99, but the run that has none - the
	// one whose card this hides - is the case that scans every tick, and a
	// loaded series runs to tens of thousands of them.
	const hasPercentileData = useMemo(() => hasPercentileSignal(timeSeries), [timeSeries]);
	const isRampUp = derived.mode === "ramp_up";

	return (
		<div className="space-y-6">
			{/* Time-Series Charts */}
			{runId && (
				<HistoricalChartsSection
					data={timeSeries}
					monitorSamples={monitorSamples}
					isLoading={isLoadingSeries}
					isFetchingMore={isFetchingMore}
					progress={progress}
					breakpoint={derived.breakpoint}
					anomalies={anomalies}
					sleeps={hostSleeps}
				/>
			)}

			{/* Latency percentiles over time / response-time-vs-concurrency (W1).
			    Mirror MetricsView's split: ramp_up → concurrency scatter (capacity
			    elbow), other modes → percentiles-over-time. Both use the centralized
			    uPlot charts, so live + history are identical. */}
			{hasPercentileData &&
				(isRampUp ? (
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">
								Response Time vs Concurrency
							</CardTitle>
						</CardHeader>
						<CardContent>
							<ResponseTimeVsConcurrencyChart
								history={timeSeries}
								breakpoint={derived.breakpoint}
								syncKey={CHART_SYNC.history}
							/>
						</CardContent>
					</Card>
				) : (
					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">
								Response Time Percentiles Over Time
							</CardTitle>
						</CardHeader>
						<CardContent>
							<LatencyPercentilesChart
								history={timeSeries}
								isCompleted
								syncKey={CHART_SYNC.history}
								breakpoint={derived.breakpoint}
								anomalies={anomalies}
								sleeps={hostSleeps}
							/>
						</CardContent>
					</Card>
				))}

			{/* What the scrape recorded, beside the chart that drew it. Present
			    whenever the run monitored anything - including a run whose every
			    scrape failed, which has a section, a failure count and no line
			    above it, and until now read as an unexplained empty chart. */}
			{report.monitor && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Server Vitals Summary</CardTitle>
					</CardHeader>
					<CardContent>
						<MonitorSummary monitor={report.monitor} />
					</CardContent>
				</Card>
			)}

			{/* Latency Statistics */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Latency Distribution</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
						<LatencyMetric label="Average" value={report.latency.avg} />
						<LatencyMetric
							label="P50 (Median)"
							value={report.latency.p50}
							variant="primary"
						/>
						{report.latency.p75 !== undefined && (
							<LatencyMetric label="P75" value={report.latency.p75} />
						)}
						<LatencyMetric label="P90" value={report.latency.p90} />
						<LatencyMetric label="P95" value={report.latency.p95} variant="warning" />
						<LatencyMetric label="P99" value={report.latency.p99} variant="danger" />
						{report.latency.p999 !== undefined && (
							<LatencyMetric
								label="P999"
								value={report.latency.p999}
								variant="danger"
							/>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Per-phase percentiles. Its own card rather than rows inside Latency
			    Distribution: those are whole-request percentiles and these split
			    one request across five phases, so a p99 here is not comparable to
			    the p99 above. Absent section = no card, as everywhere else. */}
			{report.timingBreakdown?.phases && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Phase Latency Percentiles</CardTitle>
					</CardHeader>
					<CardContent>
						<PhasePercentiles report={report} />
					</CardContent>
				</Card>
			)}

			{/* Rate Control */}
			{report.rateControl && isRateLimitedRun(derived.mode, derived.targetRps) && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Rate Control Performance</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-6">
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Target RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.targetRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Actual RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.actualRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">
									Achievement Rate
								</p>
								{/* good / caution / bad is semantics, not decoration, so all
								    three branches take the semantic -text trio. The third
								    already did; the first two were raw palette, which made
								    one expression speak two vocabularies. */}
								<p
									className={cn(
										"text-2xl font-bold",
										report.rateControl.achievement >= 95 &&
											report.rateControl.achievement <= 105
											? "text-success-text"
											: report.rateControl.achievement >= 80 &&
												  report.rateControl.achievement <= 120
												? "text-warning-text"
												: "text-destructive-text"
									)}
								>
									{formatNumber(report.rateControl.achievement)}%
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
