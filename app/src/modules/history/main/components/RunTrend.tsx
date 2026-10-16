/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunTrend
 *
 * p95 latency, throughput and error rate across the runs of one request (#2165),
 * under the open run's own Performance charts: a run's report answers "how did
 * this one go", this answers "is the request getting better or worse".
 *
 * Built from the runs list's `resultSummary` (`useRequestRunsQuery`, the query
 * the compare picker already holds), so it costs no report fetch per run. It
 * draws nothing for a run with no `requestId` and nothing until two runs have a
 * summary: one point is not a trend, and an empty frame would read as a
 * failure to load.
 */

import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { ErrorState } from "@/components/shared";
import { formatErrorRate } from "@/components/shared/run-outcome";
import {
	RunErrorRateTrendChart,
	RunP95TrendChart,
	RunThroughputTrendChart,
	fmtMs,
	fmtRate,
	type RunTrendPoint,
} from "@/modules/dashboard/components/charts/uplot";
import { useRequestRunsQuery } from "@/queries";
import { buildRunTrend } from "./run-trend";

interface RunTrendProps {
	/** The open run's request; null for a run of an unsaved request, which has no siblings. */
	requestId: string | null;
	openRunId: string;
}

type Metric = "p95Ms" | "rps" | "errorRate";

/** What a screen reader gets for a canvas: the run count and the newest recorded value. */
function describeTrend(
	title: string,
	points: RunTrendPoint[],
	metric: Metric,
	format: (v: number) => string
): string {
	const newest = [...points].reverse().find((p) => p[metric] !== null)?.[metric];
	const latest = newest == null ? "" : `, newest ${format(newest)}`;
	return `${title} across ${points.length} runs, oldest to newest${latest}`;
}

function TrendPanel({
	title,
	label,
	children,
}: {
	title: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="min-w-0 space-y-1">
			<p className="text-xs font-medium text-muted-foreground">{title}</p>
			<div role="img" aria-label={label}>
				{children}
			</div>
		</div>
	);
}

/** A metric needs two recorded runs to have a trend; a run without it is a gap. */
function hasTrend(points: RunTrendPoint[], metric: Metric): boolean {
	return points.filter((p) => p[metric] !== null).length >= 2;
}

export default function RunTrend({ requestId, openRunId }: RunTrendProps) {
	const { data, isError, error, refetch } = useRequestRunsQuery(requestId);

	if (isError) {
		return (
			<Card>
				<CardContent className="pt-4">
					<ErrorState
						variant="inline"
						title="Couldn't load this request's runs"
						detail={error instanceof Error ? error.message : undefined}
						onRetry={() => void refetch()}
					/>
				</CardContent>
			</Card>
		);
	}

	const points = buildRunTrend(data?.data ?? [], openRunId);
	if (points.length < 2) return null;

	const panels = [
		hasTrend(points, "p95Ms") && (
			<TrendPanel
				key="p95"
				title="p95 latency"
				label={describeTrend("p95 latency", points, "p95Ms", fmtMs)}
			>
				<RunP95TrendChart points={points} />
			</TrendPanel>
		),
		hasTrend(points, "rps") && (
			<TrendPanel
				key="rps"
				title="Throughput"
				label={describeTrend("Throughput", points, "rps", fmtRate)}
			>
				<RunThroughputTrendChart points={points} />
			</TrendPanel>
		),
		hasTrend(points, "errorRate") && (
			<TrendPanel
				key="error"
				title="Error rate"
				label={describeTrend("Error rate", points, "errorRate", formatErrorRate)}
			>
				<RunErrorRateTrendChart points={points} />
			</TrendPanel>
		),
	].filter(Boolean);
	if (panels.length === 0) return null;

	const hasStopped = points.some((p) => p.stopped);
	return (
		<Card className="enter-fade">
			<CardHeader className="pb-2">
				<CardTitle>This request across runs</CardTitle>
				<CardDescription>
					The last {points.length} runs, oldest first.
					{!points.some((p) => p.isOpen) && " This run is not among them."}
					{hasStopped &&
						" Stopped runs are included and marked with a dashed line: they ran for less time than planned."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-3">{panels}</div>
			</CardContent>
		</Card>
	);
}
