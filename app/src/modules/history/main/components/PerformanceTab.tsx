
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

import { useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { useRunTimeSeriesQuery } from "@/queries/runs";
import LatencyMetric from "./LatencyMetric";
import HistoricalChartsSection from "./HistoricalChartsSection";
import type { TabProps, TimeSeriesResponse } from "../../types";

export default function PerformanceTab({ report, runId }: TabProps) {
	// Fetch time-series data for charts
	const {
		data: timeSeriesData,
		isLoading,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	} = useRunTimeSeriesQuery(runId ?? null);

	// Auto-fetch all pages when component mounts or when more pages are available
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

	// Flatten paginated data into a single array
	const flattenedData = useMemo(() => {
		if (!timeSeriesData?.pages) return [];
		return timeSeriesData.pages.flatMap((page: TimeSeriesResponse) => page.data);
	}, [timeSeriesData]);

	// Calculate progress for loading indicator
	const progress = useMemo(() => {
		if (!timeSeriesData?.pages?.length) return undefined;
		const lastPage = timeSeriesData.pages[timeSeriesData.pages.length - 1];
		return {
			loaded: flattenedData.length,
			total: lastPage.pagination.total,
		};
	}, [timeSeriesData, flattenedData]);

	return (
		<div className="space-y-6">
			{/* Time-Series Charts */}
			{runId && (
				<HistoricalChartsSection
					data={flattenedData}
					isLoading={isLoading}
					isFetchingMore={isFetchingNextPage}
					progress={progress}
				/>
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

			{/* Rate Control */}
			{report.rateControl && (
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
								<p
									className={cn(
										"text-2xl font-bold",
										report.rateControl.achievement >= 95 &&
											report.rateControl.achievement <= 105
											? "text-green-600 dark:text-green-400"
											: report.rateControl.achievement >= 80 &&
												report.rateControl.achievement <= 120
												? "text-yellow-600 dark:text-yellow-400"
												: "text-destructive"
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
