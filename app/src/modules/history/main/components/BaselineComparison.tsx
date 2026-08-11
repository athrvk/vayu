/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * BaselineComparison Component
 *
 * "Is this run slower than the one I pinned?" - the deltas between the open
 * load run and the baseline pinned for the same request, in the load report's
 * header.
 *
 * Absent, not empty, when there is nothing to say: no baseline pinned, the open
 * run *is* the baseline, or the baseline's report has not loaded. A strip that
 * rendered zeros would be a claim ("nothing changed") the app cannot support.
 *
 * Colour comes from `MetricDelta.direction`, never from the sign of the number:
 * latency falling is an improvement and throughput falling is not, and the one
 * place that distinction lives is `lib/run-compare.ts`, which the MCP
 * `compare_runs` tool mirrors.
 */

import { useMemo } from "react";
import { ArrowDownRight, ArrowUpRight, GitCompareArrows, Minus, Pin } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { compareReports, deltaVerdict, type MetricDelta } from "@/lib/run-compare";
import { useBaselineRunQuery, useRunQuery, useRunReportQuery } from "@/queries";
import type { RunReport } from "@/types";

interface BaselineComparisonProps {
	/** The open run's report - the "target" of the comparison. */
	report: RunReport;
	/** The open run's id, so a run that is its own baseline draws nothing. */
	runId: string;
}

/**
 * The metrics worth a strip: the p99 a run is judged on, and the two totals.
 *
 * Three, deliberately, and not the whole diff. `compareReports` also computes
 * p50/p90/p95/avg/max and the status-code merge, and #472 listed "latency
 * percentiles and status codes" among its criteria - so the curation is
 * recorded here rather than left to read as an oversight (#503). This strip is
 * a glance in a report header, answering "is this run worse than the one I
 * pinned?" in one line; the run's own percentile charts and status-code table
 * sit a few hundred pixels below it in the same view, and an agent that wants
 * every delta has `compare_runs`. Six percentile columns here would repeat that
 * page and bury the one number the header exists to show.
 */
const HEADLINE_METRICS = ["latency.p99", "summary.avgRps", "summary.errorRate"] as const;

const METRIC_LABELS: Record<string, string> = {
	"latency.p99": "P99 latency",
	"summary.avgRps": "Throughput",
	"summary.errorRate": "Error rate",
};

/** Units belong to the metric, not to the delta arithmetic. */
function formatValue(metric: string, value: number): string {
	if (metric.startsWith("latency.")) return `${formatNumber(value)}ms`;
	if (metric === "summary.avgRps") return `${formatNumber(value)} rps`;
	if (metric === "summary.errorRate") return `${value.toFixed(2)}%`;
	return formatNumber(value);
}

function DeltaCell({ metric }: { metric: MetricDelta }) {
	const verdict = deltaVerdict(metric);
	const tone =
		verdict === "improved"
			? "text-status-success-text"
			: verdict === "regressed"
				? "text-status-error-text"
				: "text-muted-foreground";
	const Arrow =
		metric.delta === null || metric.delta === 0
			? Minus
			: metric.delta > 0
				? ArrowUpRight
				: ArrowDownRight;

	return (
		<div className="flex flex-col gap-0.5 min-w-0">
			<span className="text-xs text-muted-foreground">{METRIC_LABELS[metric.metric]}</span>
			{metric.target === null ? (
				// Neither run recorded it. Saying so beats a 0 that reads as a
				// measurement, and beats an em-dash with no explanation.
				<span className="text-sm text-muted-foreground">not recorded</span>
			) : (
				<span className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
					<span className="text-sm font-medium text-foreground">
						{formatValue(metric.metric, metric.target)}
					</span>
					<span className={cn("flex items-center gap-0.5 text-xs font-medium", tone)}>
						<Arrow className="w-3 h-3 shrink-0" />
						{metric.pctChange === null
							? metric.delta === null
								? "vs no baseline value"
								: `${metric.delta > 0 ? "+" : ""}${formatValue(metric.metric, metric.delta)}`
							: `${metric.pctChange > 0 ? "+" : ""}${metric.pctChange.toFixed(1)}%`}
					</span>
				</span>
			)}
		</div>
	);
}

export default function BaselineComparison({ report, runId }: BaselineComparisonProps) {
	/*
	 * The run row, for the request identity a baseline is looked up by - the
	 * report does not carry one (`requestId` is a property of the run, not of
	 * its aggregates). Fetched here rather than passed down: the pane above
	 * already loaded this exact query, so the shared cache answers it without a
	 * second request, and the strip stays self-contained instead of threading a
	 * prop through every LoadTestDetail call site for one child to read.
	 */
	const { data: run } = useRunQuery(runId || null);

	// A saved request is matched by id; a run of an unsaved request has only the
	// url and method its row recorded (see `useBaselineRunQuery`).
	const { data: baselineRun } = useBaselineRunQuery(
		run
			? {
					requestId: run.requestId,
					url: run.summary?.url ?? report.metadata?.requestUrl ?? null,
					method: run.summary?.method ?? report.metadata?.requestMethod ?? null,
				}
			: null
	);

	// The run being viewed is often the pinned one; comparing it with itself
	// would print a row of zeros that says nothing.
	const baselineId = baselineRun && baselineRun.id !== runId ? baselineRun.id : null;
	const { data: baselineReport } = useRunReportQuery(baselineId);

	const comparison = useMemo(
		() =>
			baselineId && baselineReport
				? compareReports(
						baselineId,
						runId,
						baselineReport as unknown as Record<string, unknown>,
						report as unknown as Record<string, unknown>
					)
				: null,
		[baselineId, baselineReport, runId, report]
	);

	if (!comparison) return null;

	const headline = [
		...comparison.latency,
		...comparison.throughput,
		...comparison.reliability,
	].filter((m) => (HEADLINE_METRICS as readonly string[]).includes(m.metric));

	return (
		<div className="mb-3 p-3 border rounded-md bg-background/50">
			<div className="flex items-center gap-2 mb-2 flex-wrap">
				<GitCompareArrows className="w-4 h-4 shrink-0 text-muted-foreground" />
				<span className="text-sm font-medium text-muted-foreground">vs baseline</span>
				{/* `variant="chip"`: this badge paints its own background, and
				    every other variant would drag a `hover:bg-*` along with it. */}
				<Badge
					variant="chip"
					className="gap-1 bg-primary/15 text-primary px-1.5 py-0 text-[10px] font-medium"
				>
					<Pin className="w-2.5 h-2.5" />
					{new Date(baselineRun!.startTime).toLocaleString()}
				</Badge>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
				{headline.map((metric) => (
					<DeltaCell key={metric.metric} metric={metric} />
				))}
			</div>
		</div>
	);
}
