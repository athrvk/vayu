/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricsView - mode-adaptive dashboard orchestrator.
 *
 * Reads the run mode (useMode), computes a single memoized {@link DashboardDerived}
 * bundle, and composes the rows:
 *   Row 1   - HeroRow        (mode-adaptive: 2 cards + universal Error Rate)
 *   Row 2   - Throughput over time   (+ ramp overlay for ramp_up)
 *   Row 2.5 - Latency over time      (perceived vs wire, queue-wait gap)
 *   Row 2.7 - Percentiles over time  (ramp_up: Response-time-vs-concurrency scatter)
 *   Row 3   - HDR percentile plot + Avg request timing waterfall
 *   Row 4   - ModeStatsRow   (mode-adaptive: 4 stat cards)
 *
 * Card/chart variants live in hero/, charts/, stats/. This file routes and
 * derives - it does not render metric chrome inline.
 */

import { memo, useMemo } from "react";
import { Activity } from "lucide-react";
import { formatNumber } from "@/utils";
import { useDashboardStore } from "@/stores";
import type { MetricsViewProps, DashboardDerived } from "../types";
import { InfoChip, fmt } from "./shared";
import { TOOLTIPS } from "./tooltips";
import { useMode } from "../hooks/useMode";
import {
	isRateLimitedRun,
	buildLatencyChartData,
	buildRampOverlay,
	buildPercentileChartData,
	buildStatusOverTime,
	latestThroughputMbps,
} from "../utils/metricsTransforms";
import { HeroRow } from "./hero/HeroRow";
import { ModeStatsRow } from "./stats/ModeStatsRow";
import {
	RequestRateChart,
	LatencyBreakdownChart,
	LatencyPercentilesChart,
	StatusCodesOverTimeChart,
	ResponseTimeVsConcurrencyChart,
	HdrPercentileChart,
	CHART_SYNC,
} from "./charts/uplot";
import { SkeletonHdrPlot } from "./charts/HdrPercentilePlot";
import { TimingWaterfall } from "./charts/TimingWaterfall";

function MetricsView({
	metrics,
	historicalMetrics,
	isCompleted,
	finalReport,
	targetRps,
	concurrency,
	mode,
	rampConfig,
}: MetricsViewProps) {
	const loadMode = useMode(mode);

	// All time-series charts render the full retained live buffer. The store trims
	// it to the user's configurable time window (constants/live-window.ts; default
	// 5 min) plus a hard safety cap, so this array already reflects the chosen
	// window. They share this one array so their x-axes cover identical spans (the
	// throughput chart and the ramp overlay share an x-axis). The old extra
	// slice(-2400) chart-level cap existed only to bound SVG/recharts DOM nodes -
	// uPlot (Canvas) renders the whole buffer cheaply, so it's gone.
	const chartWindow = historicalMetrics;

	const latencyChartData = useMemo(() => buildLatencyChartData(chartWindow), [chartWindow]);

	const percentileChartData = useMemo(() => buildPercentileChartData(chartWindow), [chartWindow]);
	const hasPercentileData = percentileChartData.some((d) => d.p99 > 0);

	const statusChartData = useMemo(() => buildStatusOverTime(chartWindow), [chartWindow]);
	const hasStatusData = statusChartData.length > 1;
	const liveMbps = useMemo(() => latestThroughputMbps(chartWindow), [chartWindow]);

	const rampOverlay = useMemo(
		() => (loadMode === "ramp_up" ? buildRampOverlay(chartWindow, rampConfig ?? {}) : null),
		[loadMode, chartWindow, rampConfig]
	);

	// Read the monotonic aggregates from the store - they are folded into running
	// values on each tick in addMetricsBatch, so this is O(1) per render instead
	// of an O(n) scan over the full historicalMetrics buffer.
	const peakConcurrency = useDashboardStore((s) => s.peakConcurrency);
	const breakpoint = useDashboardStore((s) => s.breakpoint);

	// Only the latest tick's elapsed_seconds is consumed below - depending on the
	// whole historicalMetrics array would rebuild `derived` every tick (10 Hz) and
	// defeat the React.memo on HeroRow / ModeStatsRow.
	const lastElapsedSeconds =
		historicalMetrics.length > 0
			? historicalMetrics[historicalMetrics.length - 1].elapsed_seconds
			: 0;

	// Derived bundle - computed once, consumed by HeroRow + ModeStatsRow.
	const derived = useMemo<DashboardDerived | null>(() => {
		if (!metrics || typeof metrics.requests_completed === "undefined") return null;

		// "Rate Fidelity" measures throughput fidelity (responses/sec vs target).
		// Prefer cumulative measures over current_rps (which is a delta-per-100ms
		// and routinely blips to 0 in low-RPS tests).
		const actualRps =
			finalReport?.rateControl?.actualRps ??
			finalReport?.summary?.throughput ??
			metrics.throughput ??
			metrics.current_rps;
		const droppedRequests = metrics.dropped_requests ?? 0;

		return {
			mode: loadMode,
			isCompleted,
			targetRps,
			actualRps,
			sendRate: metrics.send_rate ?? finalReport?.summary?.sendRate,
			throughput: metrics.throughput ?? finalReport?.summary?.throughput,
			currentRps: metrics.current_rps ?? 0,
			avgQueueWaitMs: metrics.avg_queue_wait_ms ?? 0,
			totalRequests: metrics.requests_completed,
			failedRequests: metrics.requests_failed ?? 0,
			statusCodes: finalReport?.statusCodes ?? {},
			requestsExpected: metrics.requests_expected ?? 0,
			requestsSent: metrics.requests_sent ?? 0,
			peakConcurrency,
			currentConcurrency: metrics.current_concurrency ?? 0,
			configuredConcurrency: rampConfig?.targetConcurrency ?? concurrency,
			backpressure: metrics.backpressure ?? 0,
			p99Latency: isCompleted
				? (finalReport?.latency?.p99 ?? metrics.latency_p99_ms ?? 0)
				: (metrics.latency_p99_ms ?? 0),
			meanLatency: metrics.avg_latency_ms ?? 0,
			medianLatency: finalReport?.latency?.p50 ?? metrics.latency_p50_ms ?? 0,
			p95Latency: finalReport?.latency?.p95 ?? metrics.latency_p95_ms ?? 0,
			testDuration: finalReport?.summary?.testDuration,
			elapsedSeconds: lastElapsedSeconds,
			setupOverhead: finalReport?.summary?.setupOverhead,
			droppedRequests,
			showDropped: isRateLimitedRun(mode, targetRps) && droppedRequests > 0,
			rampDeviationPct: rampOverlay?.rampDeviationPct,
			rampUpDurationSeconds: rampConfig?.rampUpDurationSeconds,
			startConcurrency: rampConfig?.startConcurrency,
			targetConcurrency: rampConfig?.targetConcurrency,
			breakpoint,
		};
	}, [
		metrics,
		finalReport,
		lastElapsedSeconds,
		loadMode,
		isCompleted,
		targetRps,
		concurrency,
		mode,
		rampConfig,
		peakConcurrency,
		rampOverlay,
		breakpoint,
	]);

	if (!derived) {
		return (
			<div className="p-5 text-center py-12 text-muted-foreground">
				<Activity className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
				<p>Waiting for metrics…</p>
			</div>
		);
	}

	return (
		<div className="p-5 flex flex-col gap-3.5">
			{/* Row 1 - Hero */}
			<HeroRow d={derived} />

			{/* Row 2 - Throughput over time */}
			{chartWindow.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Throughput over time
							<InfoChip tip={TOOLTIPS.throughputOverTime} />
						</h3>
						<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--primary))" }}
								/>
								throughput
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--info))" }}
								/>
								send rate
							</span>
							{targetRps !== undefined && (
								<span className="text-muted-foreground">
									<span
										className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
										style={{ background: "hsl(var(--subtle-foreground))" }}
									/>
									target {targetRps}
								</span>
							)}
							{rampOverlay && (
								<>
									<span className="text-muted-foreground">
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--subtle-foreground))" }}
										/>
										configured
									</span>
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--success))" }}
										/>
										achieved
									</span>
								</>
							)}
						</div>
					</div>
					<RequestRateChart
						history={chartWindow}
						targetRps={targetRps}
						isCompleted={isCompleted}
						rampOverlay={rampOverlay}
						syncKey={CHART_SYNC.live}
						breakpoint={breakpoint}
					/>
					{rampOverlay && (
						<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-border text-[11px] font-mono text-muted-foreground">
							<span>
								<span className="text-muted-foreground">ramp deviation </span>
								<span className="text-foreground font-semibold">
									{rampOverlay.rampDeviationPct.toFixed(1)}%
								</span>
								<InfoChip tip={TOOLTIPS.rampDeviation} />
							</span>
							<span>
								<span className="text-muted-foreground">peak achieved </span>
								<span className="text-foreground font-semibold">
									{formatNumber(rampOverlay.peakAchieved)}
								</span>
								<span className="text-muted-foreground"> / target </span>
								<span className="text-foreground font-semibold">
									{formatNumber(rampOverlay.target)}
								</span>
							</span>
							{rampOverlay.rampDeviationPct > 5 && (
								<span className="text-warning-text">⚠ ramp off target</span>
							)}
						</div>
					)}
				</div>
			)}

			{/* Row 2.5 - Latency over time (perceived vs wire, queue-wait gap) */}
			{latencyChartData.length > 1 && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Latency over time
							<InfoChip tip={TOOLTIPS.latencyOverTime} />
						</h3>
						<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--primary))" }}
								/>
								latency
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
									style={{ background: "hsl(var(--info))" }}
								/>
								wire
							</span>
							<span>
								<span
									className="inline-block w-2.5 h-2 mr-1.5 align-middle rounded-sm"
									style={{ background: "hsl(var(--warning) / 0.5)" }}
								/>
								queue wait
							</span>
						</div>
					</div>
					<LatencyBreakdownChart
						history={chartWindow}
						isCompleted={isCompleted}
						syncKey={CHART_SYNC.live}
					/>
				</div>
			)}

			{/* Row 2.7 - ramp_up shows Response-time-vs-concurrency scatter (A3);
			    every other mode shows Response-time percentiles over time. */}
			{derived.mode === "ramp_up"
				? historicalMetrics.length > 1 && (
						<div className="bg-card border border-border rounded-md p-3.5">
							<div className="flex items-baseline justify-between mb-3">
								<h3 className="text-[12px] font-semibold text-foreground">
									Response time vs concurrency
									<InfoChip tip={TOOLTIPS.responseTimeVsConcurrency} />
								</h3>
								<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
									<span>
										<span
											className="inline-block w-2 h-2 mr-1.5 rounded-full align-middle"
											style={{ background: "hsl(var(--primary))" }}
										/>
										p99
									</span>
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--warning))" }}
										/>
										SLO
									</span>
								</div>
							</div>
							<ResponseTimeVsConcurrencyChart
								history={historicalMetrics}
								breakpoint={breakpoint}
								syncKey={CHART_SYNC.live}
							/>
						</div>
					)
				: percentileChartData.length > 1 &&
					hasPercentileData && (
						<div className="bg-card border border-border rounded-md p-3.5">
							<div className="flex items-baseline justify-between mb-3">
								<h3 className="text-[12px] font-semibold text-foreground">
									Response time percentiles over time
									<InfoChip tip={TOOLTIPS.percentilesOverTime} />
								</h3>
								<div className="flex gap-3.5 text-[11px] font-mono text-muted-foreground">
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--success))" }}
										/>
										p50
									</span>
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--warning))" }}
										/>
										p95
									</span>
									<span>
										<span
											className="inline-block w-2.5 h-0.5 mr-1.5 align-middle"
											style={{ background: "hsl(var(--destructive))" }}
										/>
										p99
									</span>
								</div>
							</div>
							<LatencyPercentilesChart
								history={chartWindow}
								isCompleted={isCompleted}
								syncKey={CHART_SYNC.live}
								breakpoint={breakpoint}
							/>
						</div>
					)}

			{/* Status codes over time - stacked per-interval class composition */}
			{hasStatusData && (
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Status codes over time
							<InfoChip tip={TOOLTIPS.statusCodesOverTime} />
						</h3>
						<div className="flex items-center gap-3.5 text-[11px] font-mono text-muted-foreground">
							{(
								[
									["2xx", "hsl(var(--success))"],
									// Must match StatusCodesOverTimeChart's `categorical`
									// role, not `--primary` - see the note there.
									["3xx", "hsl(var(--chart-3))"],
									["4xx", "hsl(var(--warning))"],
									["5xx", "hsl(var(--destructive))"],
									["err", "hsl(var(--destructive) / 0.5)"],
								] as const
							).map(([label, color]) => (
								<span key={label}>
									<span
										className="inline-block w-2.5 h-2.5 mr-1.5 align-middle rounded-sm"
										style={{ background: color }}
									/>
									{label}
								</span>
							))}
							{liveMbps > 0 && (
								<span className="text-foreground">
									{fmt(liveMbps, 2)}
									<span className="text-muted-foreground"> MB/s in</span>
								</span>
							)}
						</div>
					</div>
					<StatusCodesOverTimeChart
						history={chartWindow}
						isCompleted={isCompleted}
						syncKey={CHART_SYNC.live}
					/>
				</div>
			)}

			{/* Row 3 - HDR plot + Timing waterfall */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-3">
				{/* HDR */}
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Latency distribution
							<InfoChip tip={TOOLTIPS.latencyDistribution} />
							<span className="ml-2 text-[11px] font-normal text-muted-foreground">
								HDR percentile plot
							</span>
						</h3>
						<span className="text-[10.5px] font-mono text-muted-foreground">
							{finalReport ? "from HdrHistogram" : "available after completion"}
						</span>
					</div>
					{/* Render the plot at fixed dimensions whether or not the report is
					    in yet - keeps the card height stable across the live → completed
					    transition. */}
					{finalReport ? (
						<HdrPercentileChart report={finalReport} />
					) : (
						<SkeletonHdrPlot message="p50 / p95 / p99 finalize after the run completes" />
					)}
					<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-border text-[11px] font-mono text-muted-foreground">
						<LatencyStat k="min" v={finalReport?.latency?.min} />
						<LatencyStat k="mean" v={finalReport?.latency?.avg} />
						<LatencyStat k="p50" v={finalReport?.latency?.p50} />
						<LatencyStat k="p95" v={finalReport?.latency?.p95} />
						<LatencyStat k="p99" v={finalReport?.latency?.p99} />
						<LatencyStat k="max" v={finalReport?.latency?.max} />
					</div>
				</div>

				{/* Timing waterfall */}
				<div className="bg-card border border-border rounded-md p-3.5">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-[12px] font-semibold text-foreground">
							Avg request timing
							<InfoChip tip={TOOLTIPS.avgRequestTiming} />
						</h3>
						<span className="text-[10.5px] font-mono text-muted-foreground">
							{finalReport?.timingBreakdown ? "from timing samples" : "-"}
						</span>
					</div>
					<TimingWaterfall report={finalReport} />
				</div>
			</div>

			{/* Row 4 - Bottom stat row */}
			<ModeStatsRow d={derived} />
		</div>
	);
}

function LatencyStat({ k, v }: { k: string; v: number | undefined }) {
	return (
		<span>
			<span className="text-muted-foreground">{k}</span>{" "}
			<span className="text-foreground font-semibold">{fmt(v, 0)}</span>
		</span>
	);
}

export default memo(MetricsView);
