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
import { Loader2 } from "lucide-react";
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
import { hasCustomMetrics } from "@/modules/dashboard/utils/metricsTransforms";

interface HistoricalChartsSectionProps {
	data: LoadTestMetrics[];
	/**
	 * The series fetch failed. With too little data to plot it replaces the
	 * "insufficient data" sentence, which would blame the run for the network;
	 * with an unfinished series it sits above the charts that did load.
	 */
	failure?: SeriesFailure;
	/** Server vitals scraped during the run; empty when it monitored nothing. */
	monitorSamples?: MonitorSample[];
	/**
	 * The server-vitals fetch failed. Drawn above the section whatever the time
	 * series holds, because the vitals chart it explains is itself absent and the
	 * time-series branches below would otherwise swallow it.
	 */
	monitorFailure?: SeriesFailure;
	isLoading?: boolean;
	isFetchingMore?: boolean;
	progress?: { loaded: number; total: number };
	/** The run's mode, which decides whether its concurrency series counts virtual users or requests. */
	mode?: string;
	breakpoint?: Breakpoint | null;
	anomalies?: Anomaly[] | null;
	/** Intervals the host slept under the run, marked beside the anomaly windows. */
	sleeps?: readonly HostSleep[] | null;
}

const SYNC_KEY = CHART_SYNC.history;

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
	isLoading,
	isFetchingMore,
	progress,
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
			{failure && !isFetchingMore && progress && progress.loaded < progress.total && (
				<Callout
					severity="warning"
					title="Charts are incomplete"
					action={
						<Button variant="outline" size="sm" onClick={failure.retry}>
							Try again
						</Button>
					}
				>
					Loaded {progress.loaded.toLocaleString()} of {progress.total.toLocaleString()}{" "}
					points before the fetch failed ({failure.message}).
				</Callout>
			)}

			{isFetchingMore && progress && (
				<div className="enter-fade flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-icon animate-spin" />
					<span>
						Loading more data… ({progress.loaded.toLocaleString()} /{" "}
						{progress.total.toLocaleString()} points)
					</span>
				</div>
			)}

			<Card>
				<CardHeader className="pb-2">
					<CardTitle>Request rate (throughput vs send rate)</CardTitle>
				</CardHeader>
				<CardContent>
					<RequestRateChart
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
