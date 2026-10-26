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
import { CONCURRENCY_UNIT, isConcurrencySweepMode } from "@/constants/load-test-modes";
import { isRateLimitedRun, hasPercentileSignal } from "@/modules/dashboard/utils/metricsTransforms";
import {
	LatencyPercentilesChart,
	ResponseTimeVsConcurrencyChart,
	HdrPercentileChart,
	CHART_SYNC,
} from "@/modules/dashboard/components/charts/uplot";
import { ChartLegend } from "@/modules/dashboard/components/charts/ChartLegend";
import {
	percentileLegend,
	scatterLegend,
} from "@/modules/dashboard/components/charts/uplot/legend";
import { PhasePercentiles } from "@/modules/dashboard/components/charts/PhasePercentiles";
import { StreamMetrics } from "@/modules/dashboard/components/charts/StreamMetrics";
import { LatencyStat } from "@/modules/dashboard/components/stats/LatencyStat";
import { TOOLTIPS } from "@/modules/dashboard/components/tooltips";
import LatencyMetric from "./LatencyMetric";
import { NOT_RECORDED, unrecordedFiguresOf } from "./unrecorded-figures";
import MonitorSummary from "./MonitorSummary";
import { PhaseAveragesCard } from "./PhaseAveragesCard";
import HistoricalChartsSection from "./HistoricalChartsSection";
import { useHostSleeps } from "@/stores/host-sleep-store";
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
	ticksPerBucket,
	monitorTicksPerBucket,
}: PerformanceTabProps) {
	// The run's own record of the host sleeping under it (#1357), read here by
	// run id rather than drilled from `LoadTestDetail`: Overview states them and
	// this tab marks them, and neither derives anything the other must match.
	const hostSleeps = useHostSleeps(runId);
	// The run's own line, never the Settings SLO: a run that declared none draws
	// no SLO line and judges no tile by one (#2939).
	const sloMs = derived.runSloMs;
	const hasSlo = sloMs !== undefined;
	// Stored ticks carry each second's merged percentiles (#2385), so the
	// history percentile chart / scatter can render the same views as the live
	// dashboard. Mirror MetricsView's split: ramp_up and capacity →
	// response-time-vs-concurrency scatter (capacity elbow), other modes →
	// percentiles-over-time.
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
	// loaded series runs to thousands of them.
	const hasPercentileData = useMemo(() => hasPercentileSignal(timeSeries), [timeSeries]);
	const showsConcurrencyScatter = isConcurrencySweepMode(derived.mode);
	// A failed run the engine could not fully record has an all-zero latency
	// block (#2895); drawing it would pass those zeros off as measurements.
	const latencyUnrecorded = unrecordedFiguresOf(report.summary).latency;
	// The figure the Rate fidelity card shows (a stopped run is judged by pace,
	// #2805); the stored value covers a caller that hands over no derived figure.
	const achievement = derived.rateAchievementPct ?? report.rateControl?.achievement ?? 0;

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
					ticksPerBucket={ticksPerBucket}
					monitorTicksPerBucket={monitorTicksPerBucket}
					mode={derived.mode}
					breakpoint={derived.breakpoint}
					anomalies={anomalies}
					sleeps={hostSleeps}
				/>
			)}

			{/* Latency percentiles over time / response-time-vs-concurrency (W1).
			    Mirror MetricsView's split: ramp_up and capacity → concurrency scatter
			    (capacity elbow), other modes → percentiles-over-time. Both use the
			    centralized uPlot charts, so live + history are identical. */}
			{hasPercentileData &&
				(showsConcurrencyScatter ? (
					<Card className="enter-fade">
						<CardHeader className="pb-2">
							<div className="flex items-baseline justify-between">
								<CardTitle>Response time vs {CONCURRENCY_UNIT}</CardTitle>
								<ChartLegend entries={scatterLegend(hasSlo)} />
							</div>
						</CardHeader>
						<CardContent>
							<ResponseTimeVsConcurrencyChart
								history={timeSeries}
								breakpoint={derived.breakpoint}
								sloMs={sloMs}
								kneeConcurrency={report.capacity?.kneeConcurrency}
								syncKey={CHART_SYNC.history}
							/>
						</CardContent>
					</Card>
				) : (
					<Card className="enter-fade">
						<CardHeader className="pb-2">
							<div className="flex items-baseline justify-between">
								<CardTitle>Response time percentiles over time</CardTitle>
								<ChartLegend entries={percentileLegend(hasSlo)} />
							</div>
						</CardHeader>
						<CardContent>
							<LatencyPercentilesChart
								history={timeSeries}
								isCompleted
								syncKey={CHART_SYNC.history}
								mode={derived.mode}
								breakpoint={derived.breakpoint}
								sloMs={sloMs}
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
					{latencyUnrecorded ? (
						<p className="text-sm text-muted-foreground">{NOT_RECORDED}</p>
					) : (
						<div className="grid grid-cols-2 @md:grid-cols-3 @3xl:grid-cols-6 gap-4">
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
					)}
				</CardContent>
			</Card>

			{/* The distribution's whole shape and its two ends. The tiles above stop
			    at the tail percentiles; this is the curve between them, with the
			    min and max the tiles do not carry. A card of its own so two cards do
			    not share the title "Latency distribution". Absent for a run whose latency
			    was not recorded: the card above already says so. */}
			{!latencyUnrecorded && (
				<Card className="enter-fade">
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
						<HdrPercentileChart report={report} sloMs={sloMs} />
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
			)}

			{/* Per-phase averages: the phase histograms' means (every completion)
			    when the run kept them, the retained trace sample's otherwise -
			    which is all a run with them off, or stored before the means,
			    has. Absent when the report carries no phase average. */}
			<PhaseAveragesCard timingBreakdown={report.timingBreakdown} />

			{/* Per-phase percentiles. Its own card rather than rows inside Latency
			    Distribution: those are whole-request percentiles and these split
			    one request across five phases, so a p99 here is not comparable to
			    the p99 above. Absent section = no card, as everywhere else. */}
			{report.timingBreakdown?.phases && (
				<Card className="enter-fade">
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
				<Card className="enter-fade">
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
						<div className="grid grid-cols-1 @md:grid-cols-3 gap-6">
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
										achievement >= 95 && achievement <= 105
											? "text-success-text"
											: achievement >= 80 && achievement <= 120
												? "text-warning-text"
												: "text-destructive-text"
									)}
								>
									{formatNumber(achievement)}%
								</p>
								{/* Absent on a run stored before #2392, and 0 expected is the
								    engine falling back to the legacy formula: no plan to state. */}
								{report.rateControl.requestsSent !== undefined &&
									!!report.rateControl.requestsExpected && (
										<p className="text-xs text-muted-foreground mt-1">
											{formatNumber(report.rateControl.requestsSent)} sent /{" "}
											{formatNumber(report.rateControl.requestsExpected)}{" "}
											expected
										</p>
									)}
							</div>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
