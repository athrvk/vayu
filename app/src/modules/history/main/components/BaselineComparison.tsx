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
 * A failed run the engine could not fully record (#2895) draws no delta for a
 * figure it did not measure: its zeros would read as an improvement on the
 * baseline's real numbers.
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
import { useRunReportQuery } from "@/queries";
import type { RunReport } from "@/types";
import { ComparabilityWarnings, DeltaCell } from "./run-comparison-parts";
import { unrecordedFiguresOf } from "./unrecorded-figures";
import { usePinnedBaseline } from "./usePinnedBaseline";

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
	const { target, baselineRun, baselineId } = usePinnedBaseline(
		runId,
		report.metadata?.requestUrl,
		report.metadata?.requestMethod
	);
	const { copy } = useCopy();
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

	const unrecorded = unrecordedFiguresOf(report.summary);
	// All three headline figures are unmeasured, so there is nothing to compare.
	if (unrecorded.counts) return null;

	const headline = [...comparison.latency, ...comparison.throughput, ...comparison.reliability]
		.filter((m) => (HEADLINE_METRICS as readonly string[]).includes(m.metric))
		.filter((m) => !(unrecorded.latency && m.metric.startsWith("latency.")));

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
					<Pin className="size-icon-sm" />
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
