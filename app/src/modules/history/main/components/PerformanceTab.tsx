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
import { Card, CardContent, CardHeader, CardTitle, InfoChip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber, formatRate } from "@/lib/format-number";
import { CONCURRENCY_UNIT } from "@/constants/load-test-modes";
import { isRateLimitedRun, hasPercentileSignal } from "@/modules/dashboard/utils/metricsTransforms";
import {
	LatencyPercentilesChart,
	ResponseTimeVsConcurrencyChart,
	HdrPercentileChart,
	CHART_SYNC,
} from "@/modules/dashboard/components/charts/uplot";
import { PhasePercentiles } from "@/modules/dashboard/components/charts/PhasePercentiles";
import { StreamMetrics } from "@/modules/dashboard/components/charts/StreamMetrics";
import { LatencyStat } from "@/modules/dashboard/components/stats/LatencyStat";
import { TOOLTIPS } from "@/modules/dashboard/components/tooltips";
import LatencyMetric from "./LatencyMetric";
import MonitorSummary from "./MonitorSummary";
import { PhaseAveragesCard } from "./PhaseAveragesCard";
import HistoricalChartsSection from "./HistoricalChartsSection";
import { useHostSleeps } from "@/stores/host-sleep-store";
import { useClientSettingsStore } from "@/stores";
import type { PerformanceTabProps } from "../../types";

export default function PerformanceTab({
	report,
	runId,
	derived,
	anomalies,
	timeSeries,
	seriesFailure,
	monitorSamples,
	monitorFailure,
	isLoadingSeries,
	isFetchingMore,
	progress,
}: PerformanceTabProps) {
	// The run's own record of the host sleeping under it (#1357), read here by
	// run id rather than drilled from `LoadTestDetail`: Overview states them and
	// this tab marks them, and neither derives anything the other must match.
	const hostSleeps = useHostSleeps(runId);
	const sloMs = useClientSettingsStore((s) => s.sloThresholdMs);
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
					failure={seriesFailure}
					monitorSamples={monitorSamples}
					monitorFailure={monitorFailure}
					isLoading={isLoadingSeries}
					isFetchingMore={isFetchingMore}
					progress={progress}
					mode={derived.mode}
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
					<Card className="enter-fade">
						<CardHeader className="pb-2">
							<CardTitle>Response time vs {CONCURRENCY_UNIT}</CardTitle>
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
					<Card className="enter-fade">
						<CardHeader className="pb-2">
							<CardTitle>Response time percentiles over time</CardTitle>
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
				<Card className="enter-fade">
					<CardHeader>
						<CardTitle>Server vitals summary</CardTitle>
					</CardHeader>
					<CardContent>
						<MonitorSummary monitor={report.monitor} />
					</CardContent>
				</Card>
			)}

			{/* Latency Statistics */}
			<Card>
				<CardHeader>
					<CardTitle>Latency distribution</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
						<LatencyMetric label="Average" value={report.latency.avg} />
						<LatencyMetric label="P50 (Median)" value={report.latency.p50} />
						{report.latency.p75 !== undefined && (
							<LatencyMetric label="P75" value={report.latency.p75} />
						)}
						<LatencyMetric label="P90" value={report.latency.p90} />
						<LatencyMetric
							label="P95"
							value={report.latency.p95}
							sloMs={sloMs}
							severity="warning"
						/>
						<LatencyMetric
							label="P99"
							value={report.latency.p99}
							sloMs={sloMs}
							severity="danger"
						/>
						{report.latency.p999 !== undefined && (
							<LatencyMetric
								label="P999"
								value={report.latency.p999}
								sloMs={sloMs}
								severity="danger"
							/>
						)}
					</div>
				</CardContent>
			</Card>

			{/* The distribution's whole shape and its two ends. The tiles above stop
			    at the tail percentiles; this is the curve between them, with the
			    min and max the tiles do not carry. A card of its own so two cards do
			    not share the title "Latency distribution". */}
			<Card className="enter-fade surface-card">
				<CardHeader>
					<div className="flex items-baseline justify-between">
						<CardTitle>
							HDR percentile plot
							<InfoChip tip={TOOLTIPS.latencyDistribution} />
						</CardTitle>
						<span className="text-micro font-mono text-muted-foreground">
							from HdrHistogram
						</span>
					</div>
				</CardHeader>
				<CardContent>
					<HdrPercentileChart report={report} />
					<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-rule text-label font-mono text-muted-foreground">
						<LatencyStat k="min" v={report.latency.min} />
						<LatencyStat k="mean" v={report.latency.avg} />
						<LatencyStat k="p50" v={report.latency.p50} />
						<LatencyStat k="p95" v={report.latency.p95} />
						<LatencyStat k="p99" v={report.latency.p99} />
						<LatencyStat k="max" v={report.latency.max} />
					</div>
				</CardContent>
			</Card>

			{/* Per-phase averages over the retained trace sample - the figure a run
			    that stored traces but no phase histograms still has. Absent when
			    the report carries no phase average. */}
			<PhaseAveragesCard timingBreakdown={report.timingBreakdown} />

			{/* Per-phase percentiles. Its own card rather than rows inside Latency
			    Distribution: those are whole-request percentiles and these split
			    one request across five phases, so a p99 here is not comparable to
			    the p99 above. Absent section = no card, as everywhere else. */}
			{report.timingBreakdown?.phases && (
				<Card className="enter-fade surface-card">
					<CardHeader>
						<CardTitle>Phase latency percentiles</CardTitle>
					</CardHeader>
					<CardContent>
						<PhasePercentiles report={report} />
					</CardContent>
				</Card>
			)}

			{/* Streaming runs only. Read against the First byte row above, which is
			    the same run's time to first event; absent for every run that did
			    not stream, as the engine omits the section rather than write zeros. */}
			{report.stream && (
				<Card className="enter-fade surface-card">
					<CardHeader>
						<CardTitle>
							Stream events
							<InfoChip tip={TOOLTIPS.streamEvents} />
						</CardTitle>
					</CardHeader>
					<CardContent>
						<StreamMetrics report={report} />
					</CardContent>
				</Card>
			)}

			{/* Rate Control */}
			{report.rateControl && isRateLimitedRun(derived.mode, derived.targetRps) && (
				<Card className="enter-fade">
					<CardHeader>
						<CardTitle>Rate control performance</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-6">
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Target RPS</p>
								<p className="text-metric font-bold text-foreground">
									{formatRate(report.rateControl.targetRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Actual RPS</p>
								<p className="text-metric font-bold text-foreground">
									{formatRate(report.rateControl.actualRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">
									Achievement rate
								</p>
								{/* good / caution / bad is semantics, not decoration, so all
								    three branches take the semantic -text trio. The third
								    already did; the first two were raw palette, which made
								    one expression speak two vocabularies. */}
								<p
									className={cn(
										"text-metric font-bold",
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
