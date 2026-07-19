/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoricalChartsSection — time-series charts for a completed run.
 *
 * Uses the centralized uPlot charts (same components the live dashboard renders),
 * all wired to one `syncKey` so hovering any chart moves the cursor across all of
 * them — read RPS, connections and status composition at the same instant.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { Loader2 } from "lucide-react";
import type { LoadTestMetrics } from "@/types";
import type { Breakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import {
	RequestRateChart,
	ConnectionsChart,
	StatusCodesOverTimeChart,
} from "@/modules/dashboard/components/charts/uplot";

interface HistoricalChartsSectionProps {
	data: LoadTestMetrics[];
	isLoading?: boolean;
	isFetchingMore?: boolean;
	progress?: { loaded: number; total: number };
	breakpoint?: Breakpoint | null;
}

const SYNC_KEY = "history-charts";

export default function HistoricalChartsSection({
	data,
	isLoading,
	isFetchingMore,
	progress,
	breakpoint,
}: HistoricalChartsSectionProps) {
	if (isLoading && data.length === 0) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-12">
					<div className="flex flex-col items-center gap-2 text-muted-foreground">
						<Loader2 className="h-8 w-8 animate-spin" />
						<p>Loading time-series data...</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (data.length < 2) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-8">
					<p className="text-muted-foreground">
						Insufficient data points for charts (need at least 2 seconds of data)
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-4">
			{isFetchingMore && progress && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span>
						Loading more data... ({progress.loaded.toLocaleString()} /{" "}
						{progress.total.toLocaleString()} points)
					</span>
				</div>
			)}

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">
						Request Rate (throughput vs send rate)
					</CardTitle>
				</CardHeader>
				<CardContent>
					<RequestRateChart
						history={data}
						isCompleted
						syncKey={SYNC_KEY}
						breakpoint={breakpoint}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">Active Connections</CardTitle>
				</CardHeader>
				<CardContent>
					<ConnectionsChart
						history={data}
						isCompleted
						syncKey={SYNC_KEY}
						breakpoint={breakpoint}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">Status Codes Over Time</CardTitle>
				</CardHeader>
				<CardContent>
					<StatusCodesOverTimeChart history={data} isCompleted syncKey={SYNC_KEY} />
				</CardContent>
			</Card>
		</div>
	);
}
