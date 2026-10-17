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
 * body, above the tabs.
 *
 * Absent, not empty, when there is nothing to say: no baseline pinned, the open
 * run *is* the baseline, or the baseline's report has not loaded. A strip that
 * rendered zeros would be a claim ("nothing changed") the app cannot support.
 *
 * Under the deltas, one warning row per `comparability` entry: the two runs
 * must be the same experiment (same mode, virtual users, duration, ...) for a
 * delta to mean "regressed", and a short stopped run never is (#2162).
 *
 * Colour comes from `MetricDelta.direction`, never from the sign of the number:
 * latency falling is an improvement and throughput falling is not, and the one
 * place that distinction lives is `lib/run-compare.ts`, which the MCP
 * `compare_runs` tool mirrors.
 */

import { useMemo } from "react";
import { Copy, GitCompareArrows, Pin } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { TimeValue } from "@/components/shared/TimeValue";
import { compareReports } from "@/lib/run-compare";
import { runComparisonReference } from "@/lib/agent-reference";
import { runReferenceInput } from "@/lib/run-reference-input";
import { useCopy } from "@/hooks/useCopy";
import { useBaselineRunQuery, useRunQuery, useRunReportQuery } from "@/queries";
import type { RunReport } from "@/types";
import { ComparabilityWarnings, DeltaCell } from "./run-comparison-parts";

interface BaselineComparisonProps {
	/** The open run's report - the "target" of the comparison. */
	report: RunReport;
	/** The open run's id, so a run that is its own baseline draws nothing. */
	runId: string;
}

/**
 * The metrics worth a strip: the p99 a run is judged on, and the two totals.
 *
 * Three, deliberately: this is a glance above the report's tabs, answering "is this
 * run worse than the one I pinned?" in one line. The rest of the diff (every
 * percentile, both throughput measures, the status-code merge) is the header's
 * Compare action, `RunComparisonView`, against the baseline or any other run of
 * the request (#2164).
 */
const HEADLINE_METRICS = ["latency.p99", "summary.avgRps", "summary.errorRate"] as const;

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
	const target = run ? runReferenceInput(run) : null;
	const { copy } = useCopy();

	// A saved request is matched by id; a run of an unsaved request has only the
	// url and method its row recorded (see `useBaselineRunQuery`).
	const { data: baselineRun } = useBaselineRunQuery(
		run
			? {
					requestId: run.requestId,
					url: target?.summary?.url ?? report.metadata?.requestUrl ?? null,
					method: target?.summary?.method ?? report.metadata?.requestMethod ?? null,
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

	if (!comparison || !baselineRun || !target) return null;

	const headline = [
		...comparison.latency,
		...comparison.throughput,
		...comparison.reliability,
	].filter((m) => (HEADLINE_METRICS as readonly string[]).includes(m.metric));

	return (
		<div className="enter-fade p-3 border rounded-md bg-background/50">
			<div className="flex items-center gap-2 mb-2 flex-wrap">
				<GitCompareArrows className="size-icon shrink-0 text-muted-foreground" />
				<span className="text-sm font-medium text-muted-foreground">vs baseline</span>
				{/* `variant="chip"`: this badge paints its own background, and
				    every other variant would drag a `hover:bg-*` along with it. */}
				<Badge
					variant="chip"
					className="gap-1 bg-primary/15 text-primary px-1.5 py-0 text-micro font-semibold"
				>
					<Pin className="w-2.5 h-2.5" />
					<TimeValue value={baselineRun.startTime} />
				</Badge>
				<Button
					variant="ghost"
					size="sm"
					className="ml-auto h-control-sm gap-1.5 px-2 text-xs"
					onClick={() =>
						void copy(
							runComparisonReference(runReferenceInput(baselineRun), target),
							"Reference"
						)
					}
				>
					<Copy className="size-icon-sm" aria-hidden="true" />
					Copy comparison for agent
				</Button>
			</div>
			<div className="grid grid-cols-1 @md:grid-cols-3 gap-3">
				{headline.map((metric) => (
					<DeltaCell key={metric.metric} metric={metric} />
				))}
			</div>
			<ComparabilityWarnings warnings={comparison.comparability} />
		</div>
	);
}
