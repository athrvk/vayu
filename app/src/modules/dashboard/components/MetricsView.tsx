/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricsView - mode-adaptive dashboard orchestrator for a run in progress.
 * A finished run is drawn by History's `LoadTestDetail` instead (#2220).
 *
 * Reads the run mode (useMode), computes a single memoized {@link DashboardDerived}
 * bundle, and composes the rows:
 *   Row 1   - HeroRow        (mode-adaptive: 2 cards + universal Error Rate; the
 *                             throughput-led modes add a p95/p99 latency card)
 *   Row 2   - Throughput over time   (+ ramp overlay for ramp_up)
 *   Row 2.5 - Latency over time      (average latency vs wire time, queue-wait gap)
 *   Row 2.7 - Percentiles over time  (ramp_up: Response-time-vs-concurrency scatter)
 *   Row 3   - HDR percentile plot + Avg request timing waterfall, as placeholders:
 *             both need the final report
 *   Row 4   - ModeStatsRow   (mode-adaptive: 3 or 4 stat cards)
 *
 * Card/chart variants live in hero/, charts/, stats/. This file routes and
 * derives - it does not render metric chrome inline.
 */

import { memo, useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { formatNumber, formatPercent, formatRate } from "@/lib/format-number";
import { CONCURRENCY_UNIT } from "@/constants/load-test-modes";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/EmptyState";
import { useDashboardStore } from "@/stores";
import { useHostSleeps } from "@/stores/host-sleep-store";
import type { MetricsViewProps, DashboardDerived } from "../types";
import { InfoChip } from "./shared";
import { TOOLTIPS } from "./tooltips";
import { STATUS_CLASS_SERIES, STATUS_CLASS_CSS_VAR } from "@/constants/http-status";
import { useMode } from "../hooks/useMode";
import {
	isRateLimitedRun,
	buildRampOverlay,
	hasPercentileSignal,
	hasStatusSeries,
	hasCustomMetrics,
	latestThroughputMbps,
	spansMultipleBuckets,
	hasWindowLatency,
} from "../utils/metricsTransforms";
import { createAnomalyDetector, wholeSecondTicks } from "../utils/detectAnomalies";
import { cumulativePercentiles, hasSecondPercentiles } from "../utils/tickPercentiles";
import { errorBreakdown } from "../utils/errorBreakdown";
import { liveRateFidelity } from "../utils/rateFidelity";
import { HeroRow } from "./hero/HeroRow";
import { ModeStatsRow } from "./stats/ModeStatsRow";
import { LatencyStat } from "./stats/LatencyStat";
import {
	RequestRateChart,
	LatencyBreakdownChart,
	LatencyPercentilesChart,
	StatusCodesOverTimeChart,
	ResponseTimeVsConcurrencyChart,
	ServerVitalsChart,
	CustomMetricsChart,
	CHART_SYNC,
} from "./charts/uplot";
import { SkeletonHdrPlot } from "./charts/HdrPercentilePlot";
import { ChartLegend } from "./charts/ChartLegend";
import {
	LATENCY_ENTRIES,
	PERCENTILE_ENTRIES,
	SCATTER_ENTRIES,
	throughputLegend,
} from "./charts/uplot/legend";
import { hasSendRate } from "./charts/uplot/buildData";
import { TimingWaterfall } from "./charts/TimingWaterfall";

/** The HDR card's footer figures, drawn as dashes until the report has them. */
const HDR_FOOTER_STATS = ["min", "mean", "p50", "p95", "p99", "max"] as const;

function MetricsView({
	metrics,
	historicalMetrics,
	targetRps,
	concurrency,
	mode,
	runDurationSeconds,
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

	// Which chart cards are worth rendering. Each chart builds its own series
	// from `chartWindow` (it also needs the user's bucket width, which only it
	// reads), so these gates ask the cheap question - is there more than one
	// 0.5s bucket to plot - rather than building the series a second time here
	// and throwing it away (#1152).
	// The latency chart plots the ticks that hold a window mean (an idle window
	// and a run stored before the window existed hold none), so it is gated on
	// those, not on every tick.
	const hasLatencyPoints = useMemo(
		() => spansMultipleBuckets(chartWindow, hasWindowLatency),
		[chartWindow]
	);
	// The chart and its legend read the same answer, so a send-rate entry never
	// labels a line the chart did not draw.
	const hasSend = useMemo(() => hasSendRate(chartWindow), [chartWindow]);
	const hasPercentileData = useMemo(() => hasPercentileSignal(chartWindow), [chartWindow]);
	// The percentile series is one point a second (a live frame between gates
	// holds none), so its own count gates the card, not the latency chart's.
	const hasPercentilePoints = useMemo(
		() => spansMultipleBuckets(chartWindow, hasSecondPercentiles),
		[chartWindow]
	);
	const hasStatusData = useMemo(() => hasStatusSeries(chartWindow), [chartWindow]);
	// Presence, not "spans multiple buckets" - mirrors `ServerVitalsChart`'s own
	// gate below (`monitorSamples.length > 0 && chartWindow.length > 1`) rather
	// than `hasStatusData`'s bucket-count question, since a custom metric's tick
	// cadence is whatever the script chose to record at, not the engine's.
	const hasCustomMetricsData = useMemo(() => chartWindow.some(hasCustomMetrics), [chartWindow]);
	const liveMbps = useMemo(() => latestThroughputMbps(chartWindow), [chartWindow]);

	const rampOverlay = useMemo(
		() => (loadMode === "ramp_up" ? buildRampOverlay(chartWindow, rampConfig ?? {}) : null),
		[loadMode, chartWindow, rampConfig]
	);

	/*
	 * Degradation windows, derived here beside the other series transforms rather
	 * than inside `derived` below: that bundle deliberately depends on the latest
	 * tick and not on the whole history array, so folding a history-wide scan into
	 * it would rebuild it at 10 Hz and defeat the React.memo on HeroRow /
	 * ModeStatsRow. The charts are the consumers, and they take it directly.
	 *
	 * The detector is held across commits rather than re-run from scratch on each
	 * one. `chartWindow`'s identity changes every time the store appends a batch,
	 * so a pure derivation re-derived the whole retained buffer twice a second -
	 * a trailing-median sort per tick per series, ~9,000 of them at the default
	 * window (#1151). Handed the same buffer again it takes only what arrived.
	 * It answers exactly what the one-shot `detectAnomalies` would, including for
	 * a buffer that is not a continuation (a second run, a remount), which it
	 * starts over on - so nothing here depends on the instance surviving. Held in
	 * `useState` rather than a ref because the state initialiser is the one hook
	 * that runs exactly once without reading anything during render.
	 *
	 * It reads the gate frames only, one a second like History's stored ticks,
	 * since its rules count ticks (#2589). Filtered in a memo of its own so a
	 * second render of one buffer still reaches the detector's memo.
	 */
	const [detector] = useState(createAnomalyDetector);
	const detectorSeries = useMemo(() => wholeSecondTicks(chartWindow), [chartWindow]);
	const anomalies = useMemo(() => detector.detect(detectorSeries), [detector, detectorSeries]);

	// Read the monotonic aggregates from the store - they are folded into running
	// values on each tick in addMetricsBatch, so this is O(1) per render instead
	// of an O(n) scan over the full historicalMetrics buffer.
	const peakConcurrency = useDashboardStore((s) => s.peakConcurrency);
	const breakpoint = useDashboardStore((s) => s.breakpoint);
	const p99AtPeakMs = useDashboardStore((s) => s.p99AtPeakMs);
	// Empty for a run that configured no monitor - the row below reads that
	// rather than the config, so it is right for a replayed run too.
	const monitorSamples = useDashboardStore((s) => s.monitorSamples);
	// Marked on the same layer as the anomaly windows: a stretch where the host
	// was asleep is a hole in the series no detector can account for, because the
	// engine was suspended with it (#1357).
	const currentRunId = useDashboardStore((s) => s.currentRunId);
	const hostSleeps = useHostSleeps(currentRunId);

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

		const fidelity = liveRateFidelity({
			targetRps,
			requestsSent: metrics.requests_sent,
			elapsedSeconds: lastElapsedSeconds,
			durationSeconds: runDurationSeconds,
		});
		const droppedRequests = metrics.dropped_requests ?? 0;
		// Over the run so far, the span `avg_latency_ms` covers, so the card's
		// mean, median and tail describe one population (issue #2385).
		const cumulative = cumulativePercentiles(metrics);
		const failedRequests = metrics.requests_failed ?? 0;
		const { httpErrors, noResponse } = errorBreakdown(
			failedRequests,
			metrics.http_errors,
			metrics.no_response
		);

		return {
			mode: loadMode,
			isCompleted: false,
			targetRps,
			actualRps: fidelity?.actualRps,
			rateAchievementPct: fidelity?.achievementPct,
			sendRate: metrics.send_rate,
			throughput: metrics.throughput,
			currentRps: metrics.current_rps ?? 0,
			avgQueueWaitMs: metrics.avg_queue_wait_ms ?? 0,
			totalRequests: metrics.requests_completed,
			failedRequests,
			httpErrors,
			noResponse,
			// The live tick's map is what fills the bar during the run (issue #2124).
			statusCodes: metrics.status_codes ?? {},
			requestsExpected: metrics.requests_expected ?? 0,
			requestsSent: metrics.requests_sent ?? 0,
			peakConcurrency,
			currentConcurrency: metrics.current_concurrency ?? 0,
			configuredConcurrency: rampConfig?.targetConcurrency ?? concurrency,
			backpressure: metrics.backpressure ?? 0,
			p99Latency: cumulative.p99,
			meanLatency: metrics.avg_latency_ms ?? 0,
			medianLatency: cumulative.p50,
			p95Latency: cumulative.p95,
			elapsedSeconds: lastElapsedSeconds,
			droppedRequests,
			showDropped: isRateLimitedRun(mode, targetRps) && droppedRequests > 0,
			rampDeviationPct: rampOverlay?.rampDeviationPct,
			rampUpDurationSeconds: rampConfig?.rampUpDurationSeconds,
			startConcurrency: rampConfig?.startConcurrency,
			targetConcurrency: rampConfig?.targetConcurrency,
			breakpoint,
			p99AtPeakMs,
		};
	}, [
		metrics,
		lastElapsedSeconds,
		loadMode,
		targetRps,
		concurrency,
		mode,
		runDurationSeconds,
		rampConfig,
		peakConcurrency,
		rampOverlay,
		breakpoint,
		p99AtPeakMs,
	]);

	if (!derived) {
		return <EmptyState icon={Activity} title="Waiting for metrics…" />;
	}

	return (
		<div className="@container p-5 flex flex-col gap-3.5">
			{/* Row 1 - Hero */}
			<HeroRow d={derived} />

			{/* Row 2 - Throughput over time */}
			{chartWindow.length > 1 && (
				<Card pad="sm">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Throughput over time
							<InfoChip tip={TOOLTIPS.throughputOverTime} />
						</h3>
						<ChartLegend
							entries={throughputLegend(targetRps, rampOverlay != null, hasSend)}
						/>
					</div>
					<RequestRateChart
						history={chartWindow}
						targetRps={targetRps}
						rampOverlay={rampOverlay}
						mode={loadMode}
						syncKey={CHART_SYNC.live}
						breakpoint={breakpoint}
						anomalies={anomalies}
						sleeps={hostSleeps}
					/>
					{rampOverlay && (
						<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-rule text-label font-mono text-muted-foreground">
							<span>
								<span className="text-muted-foreground">ramp deviation </span>
								<span className="text-foreground font-semibold">
									{formatPercent(rampOverlay.rampDeviationPct)}%
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
				</Card>
			)}

			{/* Row 2.5 - Latency over time (perceived vs wire, queue-wait gap) */}
			{hasLatencyPoints && (
				<Card pad="sm">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Latency over time
							<InfoChip tip={TOOLTIPS.latencyOverTime} />
						</h3>
						<ChartLegend entries={LATENCY_ENTRIES} />
					</div>
					<LatencyBreakdownChart
						history={chartWindow}
						syncKey={CHART_SYNC.live}
						anomalies={anomalies}
						sleeps={hostSleeps}
					/>
				</Card>
			)}

			{/* Row 2.7 - ramp_up shows Response-time-vs-concurrency scatter (A3);
			    every other mode shows Response-time percentiles over time. */}
			{derived.mode === "ramp_up"
				? historicalMetrics.length > 1 && (
						<Card pad="sm">
							<div className="flex items-baseline justify-between mb-3">
								<h3 className="text-xs font-semibold text-foreground">
									Response time vs {CONCURRENCY_UNIT}
									<InfoChip tip={TOOLTIPS.responseTimeVsConcurrency} />
								</h3>
								<ChartLegend entries={SCATTER_ENTRIES} />
							</div>
							<ResponseTimeVsConcurrencyChart
								history={historicalMetrics}
								breakpoint={breakpoint}
								syncKey={CHART_SYNC.live}
							/>
						</Card>
					)
				: hasPercentilePoints &&
					hasPercentileData && (
						<Card pad="sm">
							<div className="flex items-baseline justify-between mb-3">
								<h3 className="text-xs font-semibold text-foreground">
									Response time percentiles over time
									<InfoChip tip={TOOLTIPS.percentilesOverTime} />
								</h3>
								<ChartLegend entries={PERCENTILE_ENTRIES} />
							</div>
							<LatencyPercentilesChart
								history={chartWindow}
								syncKey={CHART_SYNC.live}
								mode={loadMode}
								breakpoint={breakpoint}
								anomalies={anomalies}
								sleeps={hostSleeps}
							/>
						</Card>
					)}

			{/* Status codes over time - stacked per-interval class composition */}
			{hasStatusData && (
				<Card pad="sm">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Status codes over time
							<InfoChip tip={TOOLTIPS.statusCodesOverTime} />
						</h3>
						{/*
						    Driven by `constants/http-status`, not a literal list. These
						    five were hardcoded `hsl(var(--success))` strings, so when the
						    chart moved onto the status token family every swatch silently
						    became a different colour from the band it labels.
						 */}
						<div className="flex items-center gap-3.5 text-label font-mono text-muted-foreground">
							{STATUS_CLASS_SERIES.map(({ label, cls }) => ({
								label,
								color: `hsl(var(${STATUS_CLASS_CSS_VAR[cls]}))`,
							})).map(({ label, color }) => (
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
									{formatRate(liveMbps)}
									<span className="text-muted-foreground"> MB/s in</span>
								</span>
							)}
						</div>
					</div>
					<StatusCodesOverTimeChart history={chartWindow} syncKey={CHART_SYNC.live} />
				</Card>
			)}

			{/* Server vitals - only for a run that scraped an endpoint, so a run
			    without a monitor block keeps the dashboard it always had. */}
			{monitorSamples.length > 0 && chartWindow.length > 1 && (
				<Card pad="sm">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Server vitals
							<InfoChip tip={TOOLTIPS.serverVitals} />
						</h3>
						<span className="text-micro font-mono text-muted-foreground">
							scraped from the target
						</span>
					</div>
					<ServerVitalsChart
						history={chartWindow}
						samples={monitorSamples}
						syncKey={CHART_SYNC.live}
						anomalies={anomalies}
						sleeps={hostSleeps}
					/>
				</Card>
			)}

			{/* Custom metrics - only for a run that declared metric.record / pm.metrics
			    names, so a run that recorded none keeps the dashboard it always had. */}
			{hasCustomMetricsData && chartWindow.length > 1 && (
				<Card pad="sm">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Custom metrics
							<InfoChip tip={TOOLTIPS.customMetrics} />
						</h3>
						<span className="text-micro font-mono text-muted-foreground">
							metric.record / pm.metrics
						</span>
					</div>
					<CustomMetricsChart history={chartWindow} syncKey={CHART_SYNC.live} />
				</Card>
			)}

			{/* Row 3 - HDR plot + Timing waterfall. Both read the final report, which
			    replaces this view when it lands, so here they only hold the place. */}
			<div className="grid grid-cols-1 @3xl:grid-cols-2 gap-3">
				{/* HDR */}
				<Card pad="sm" className="min-w-0">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Latency distribution
							<InfoChip tip={TOOLTIPS.latencyDistribution} />
							<span className="ml-2 text-label font-normal text-muted-foreground">
								HDR percentile plot
							</span>
						</h3>
						<span className="text-micro font-mono text-muted-foreground">
							available after completion
						</span>
					</div>
					<SkeletonHdrPlot message="p50 / p95 / p99 finalize after the run completes" />
					<div className="flex justify-between gap-3 mt-2.5 pt-2.5 border-t border-dashed border-rule text-label font-mono text-muted-foreground">
						{HDR_FOOTER_STATS.map((k) => (
							<LatencyStat key={k} k={k} v={undefined} />
						))}
					</div>
				</Card>

				{/* Timing waterfall */}
				<Card pad="sm" className="min-w-0">
					<div className="flex items-baseline justify-between mb-3">
						<h3 className="text-xs font-semibold text-foreground">
							Avg request timing
							<InfoChip tip={TOOLTIPS.avgRequestTiming} />
						</h3>
						<span className="text-micro font-mono text-muted-foreground">-</span>
					</div>
					<TimingWaterfall report={null} />
				</Card>
			</div>

			{/* Row 4 - Bottom stat row */}
			<ModeStatsRow d={derived} />
		</div>
	);
}

export default memo(MetricsView);
