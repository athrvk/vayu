/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoricalChartsSection - time-series charts for a completed run.
 *
 * Uses the centralized uPlot charts (same components the live dashboard renders),
 * all wired to one `syncKey` so hovering any chart moves the cursor across all of
 * them - read RPS, concurrency and status composition at the same instant.
 */

import { Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { Callout, DetailSkeleton, EmptyState, ErrorState } from "@/components/shared";
import { formatNumber, formatSeconds } from "@/lib/format-number";
import type { LoadTestMetrics, MonitorSample } from "@/types";
import { CONCURRENCY_UNIT, IN_FLIGHT_LABEL, isClosedLoopMode } from "@/constants/load-test-modes";
import type { Breakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import type { Anomaly } from "@/modules/dashboard/utils/detectAnomalies";
import type { HostSleep } from "@/stores/host-sleep-store";
import type { SeriesFailure } from "../../types";
import {
	RequestRateChart,
	ConnectionsChart,
	StatusCodesOverTimeChart,
	ServerVitalsChart,
	CustomMetricsChart,
	CHART_SYNC,
} from "@/modules/dashboard/components/charts/uplot";
import { ChartLegend } from "@/modules/dashboard/components/charts/ChartLegend";
import { throughputLegend } from "@/modules/dashboard/components/charts/uplot/legend";
import { hasSendRate } from "@/modules/dashboard/components/charts/uplot/buildData";
import { hasCustomMetrics } from "@/modules/dashboard/utils/metricsTransforms";

interface HistoricalChartsSectionProps {
	data: LoadTestMetrics[];
	/**
	 * The series fetch failed. With too little data to plot it replaces the
	 * "insufficient data" sentence, which would blame the run for the network.
	 */
	failure?: SeriesFailure;
	/**
	 * Stored ticks the engine folded into each point of `data` (#2547); absent
	 * when the series is raw, one tick a second.
	 */
	ticksPerBucket?: number;
	/** Server vitals scraped during the run; empty when it monitored nothing. */
	monitorSamples?: MonitorSample[];
	/**
	 * Scrapes the engine folded into each entry of `monitorSamples` (#2611); absent
	 * when they are raw. Independent of `ticksPerBucket`: a run can have a long
	 * tick series and a short vitals one, or the reverse.
	 */
	monitorTicksPerBucket?: number;
	/**
	 * The server-vitals fetch failed. Drawn above the section whatever the time
	 * series holds, because the vitals chart it explains is itself absent and the
	 * time-series branches below would otherwise swallow it.
	 */
	monitorFailure?: SeriesFailure;
	isLoading?: boolean;
	/** The run's mode, which decides whether its concurrency series counts virtual users or requests. */
	mode?: string;
	breakpoint?: Breakpoint | null;
	anomalies?: Anomaly[] | null;
	/** Intervals the host slept under the run, marked beside the anomaly windows. */
	sleeps?: readonly HostSleep[] | null;
}

const SYNC_KEY = CHART_SYNC.history;

/**
 * What a point is on a downsampled series, and what that does to the events
 * judged over it (#2547; the fold rules are the engine's, the detector's
 * reading of them is spelled out in `LoadTestDetail`). Stored ticks are one a
 * second, so a bucket of N ticks is N seconds.
 */
function BucketNote({ ticksPerBucket }: { ticksPerBucket: number }) {
	return (
		<Callout
			severity="info"
			title={`Each point covers ${formatSeconds(ticksPerBucket)} of this run`}
		>
			Latency and concurrency show the worst second in it, counts and rates their value at its
			end. Events are judged point to point, so a slowdown has to span two points to be named;
			the breakpoint still marks the first point holding a second over its p99 line.
		</Callout>
	);
}

/**
 * What a point is on a downsampled vitals series (#2611). Only drawn for a
 * bucketed one, so there are always at least two scrapes in a point. The engine
 * keeps each series' max over the bucket, so a one-scrape spike in a gauge
 * survives.
 */
function VitalsBucketNote({ scrapesPerBucket }: { scrapesPerBucket: number }) {
	return (
		<Callout
			severity="info"
			className="mb-3"
			title={`Each point covers ${formatNumber(scrapesPerBucket)} scrapes`}
		>
			Each series shows its highest value among them, so a one-scrape spike stays visible.
		</Callout>
	);
}

export default function HistoricalChartsSection({
	monitorFailure,
	...seriesProps
}: HistoricalChartsSectionProps) {
	return (
		<>
			{monitorFailure && (
				<Callout
					severity="warning"
					title="Couldn't load the server vitals"
					action={
						<Button variant="outline" size="sm" onClick={monitorFailure.retry}>
							Try again
						</Button>
					}
				>
					{monitorFailure.message}
				</Callout>
			)}
			<SeriesCharts {...seriesProps} />
		</>
	);
}

function SeriesCharts({
	data,
	failure,
	monitorSamples = [],
	monitorTicksPerBucket,
	isLoading,
	ticksPerBucket,
	mode,
	breakpoint,
	anomalies,
	sleeps,
}: Omit<HistoricalChartsSectionProps, "monitorFailure">) {
	if (isLoading && data.length === 0) {
		return (
			<Card>
				<CardContent>
					<DetailSkeleton label="Loading time-series data" className="p-0" />
				</CardContent>
			</Card>
		);
	}

	if (failure && data.length < 2) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-8">
					<ErrorState
						title="Couldn't load the time-series data"
						detail={failure.message}
						onRetry={failure.retry}
					/>
				</CardContent>
			</Card>
		);
	}

	// This counts points, not seconds. Only a run longer than
	// HISTORY_SERIES_MAX_POINTS ticks is bucketed, and into many points, so a
	// series this short is raw and each of its points is a second.
	if (data.length < 2) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-8">
					<EmptyState
						title="Not enough data for charts yet"
						description="Charts need at least 2 seconds of data."
					/>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			{ticksPerBucket !== undefined && <BucketNote ticksPerBucket={ticksPerBucket} />}

			<Card>
				<CardHeader className="pb-2">
					{/* This chart draws no target line or ramp pair (only the live view
					    is told the target), so the key names neither. */}
					<div className="flex items-baseline justify-between">
						<CardTitle>Request rate (throughput vs send rate)</CardTitle>
						<ChartLegend
							entries={throughputLegend(undefined, false, hasSendRate(data))}
						/>
					</div>
				</CardHeader>
				<CardContent>
					<RequestRateChart
						history={data}
						isCompleted
						syncKey={SYNC_KEY}
						mode={mode}
						breakpoint={breakpoint}
						anomalies={anomalies}
						sleeps={sleeps}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle>
						{isClosedLoopMode(mode) ? `Active ${CONCURRENCY_UNIT}` : IN_FLIGHT_LABEL}
					</CardTitle>
				</CardHeader>
				<CardContent>
					<ConnectionsChart
						mode={mode}
						history={data}
						isCompleted
						syncKey={SYNC_KEY}
						breakpoint={breakpoint}
						anomalies={anomalies}
						sleeps={sleeps}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle>Status codes over time</CardTitle>
				</CardHeader>
				<CardContent>
					<StatusCodesOverTimeChart history={data} isCompleted syncKey={SYNC_KEY} />
				</CardContent>
			</Card>

			{/* The same row the live dashboard draws, on the same sync group -
			    absent for a run that scraped nothing rather than an empty card. */}
			{monitorSamples.length > 0 && (
				<Card className="enter-fade">
					<CardHeader className="pb-2">
						<CardTitle>Server vitals</CardTitle>
					</CardHeader>
					<CardContent>
						{monitorTicksPerBucket !== undefined && (
							<VitalsBucketNote scrapesPerBucket={monitorTicksPerBucket} />
						)}
						<ServerVitalsChart
							history={data}
							samples={monitorSamples}
							isCompleted
							syncKey={SYNC_KEY}
							anomalies={anomalies}
							sleeps={sleeps}
						/>
					</CardContent>
				</Card>
			)}

			{/* Custom metrics - absent for a run that recorded no metric.record /
			    pm.metrics value, same "no card" rule the vitals row above follows. */}
			{data.some(hasCustomMetrics) && (
				<Card className="enter-fade">
					<CardHeader className="pb-2">
						<CardTitle>Custom metrics</CardTitle>
					</CardHeader>
					<CardContent>
						<CustomMetricsChart history={data} isCompleted syncKey={SYNC_KEY} />
					</CardContent>
				</Card>
			)}
		</div>
	);
}
