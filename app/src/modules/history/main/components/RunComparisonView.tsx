/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunComparisonView
 *
 * The open load run against any other finished load run of the same request:
 * every latency percentile, both throughput measures, the reliability rows and
 * the status-code merge, under the comparability warnings. It is the full diff
 * behind the report header's vs-baseline strip, and it replaces the report's
 * tabs in the same pane rather than opening a tab of its own (#2164).
 *
 * The compared run defaults to the pinned baseline when there is one and it is
 * not the open run, else the newest other run. The compared run is the base and
 * the open run the target, as in `BaselineComparison`: a delta reads "this run
 * against that one".
 */

import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import {
	Button,
	ScrollArea,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import { DetailSkeleton, EmptyState, ErrorState, RUN_STATUS } from "@/components/shared";
import { STATUS_CLASS_STYLE, httpStatusClass, statusCodeLabel } from "@/constants/http-status";
import { formatNumber } from "@/lib/format-number";
import { formatInstant } from "@/lib/time-value";
import { compareReports, type MetricDelta } from "@/lib/run-compare";
import { cn } from "@/lib/utils";
import {
	isRunNotFound,
	useBaselineRunQuery,
	useRequestRunsQuery,
	useRunQuery,
	useRunReportQuery,
} from "@/queries";
import type { Run, RunReport } from "@/types";
import { comparableRuns } from "./comparable-runs";
import { METRIC_LABELS, formatValue } from "./run-comparison-format";
import { ComparabilityWarnings, DeltaChange } from "./run-comparison-parts";

interface RunComparisonViewProps {
	/** The open run's report - the "target" of the comparison. */
	report: RunReport;
	runId: string;
	/** The request whose runs are offered; a comparison across requests is not one. */
	requestId: string;
	/** Back to the report's tabs. */
	onClose: () => void;
	/**
	 * What the report shows above its tabs (request, configuration, ...), drawn
	 * first in the scrolling body so a comparison does not lose it.
	 */
	runContext?: ReactNode;
}

/** What tells two runs of one request apart in the picker: when, how it ended, whether pinned. */
function runOptionLabel(run: Run): string {
	const pinned = run.baseline ? " - Baseline" : "";
	return `${formatInstant(run.startTime)} - ${RUN_STATUS[run.status].label}${pinned}`;
}

function MetricValue({ metric, value }: { metric: string; value: number | null }) {
	if (value === null) return <span className="text-muted-foreground">not recorded</span>;
	return <span className="text-foreground">{formatValue(metric, value)}</span>;
}

function MetricRow({ metric }: { metric: MetricDelta }) {
	return (
		<TableRow>
			<TableCell className="text-muted-foreground">{METRIC_LABELS[metric.metric]}</TableCell>
			<TableCell className="tabular-nums">
				<MetricValue metric={metric.metric} value={metric.base} />
			</TableCell>
			<TableCell className="tabular-nums">
				<MetricValue metric={metric.metric} value={metric.target} />
			</TableCell>
			<TableCell>
				{metric.delta === null ? (
					<span className="text-muted-foreground">-</span>
				) : (
					<DeltaChange metric={metric} />
				)}
			</TableCell>
		</TableRow>
	);
}

const COLUMN_HEADS = ["Compared run", "This run", "Change"];

function StatusCodeTable({
	statusCodes,
}: {
	statusCodes: Record<string, { base: number; target: number }>;
}) {
	const codes = Object.keys(statusCodes).sort((a, b) => Number(a) - Number(b));
	if (codes.length === 0) return null;

	return (
		<section className="flex flex-col gap-2" aria-label="Status codes">
			<h3 className="text-sm font-semibold text-foreground">Status codes</h3>
			<div className="surface-card border border-border rounded-md bg-card overflow-hidden">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Status code</TableHead>
							{COLUMN_HEADS.map((head) => (
								<TableHead key={head}>{head}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{codes.map((code) => {
							const { base, target } = statusCodes[code];
							const change = target - base;
							const style = STATUS_CLASS_STYLE[httpStatusClass(Number(code))];
							return (
								<TableRow key={code}>
									<TableCell className={cn("font-mono font-medium", style.text)}>
										{statusCodeLabel(Number(code))}
									</TableCell>
									<TableCell className="tabular-nums">
										{formatNumber(base)}
									</TableCell>
									<TableCell className="tabular-nums">
										{formatNumber(target)}
									</TableCell>
									<TableCell className="tabular-nums text-muted-foreground">
										{change > 0 ? "+" : ""}
										{formatNumber(change)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</section>
	);
}

/** The diff of one chosen run against the open one, once it is chosen. */
function ComparisonPanel({
	comparedId,
	runId,
	report,
}: {
	comparedId: string;
	runId: string;
	report: RunReport;
}) {
	// The run row for its status (a report is final only once the run is) and
	// for telling a deletion from an engine that did not answer.
	const { data: comparedRun, error: comparedRunError } = useRunQuery(comparedId);
	const {
		data: comparedReport,
		error: reportError,
		refetch: refetchReport,
	} = useRunReportQuery(comparedId, comparedRun?.status);

	const comparison = useMemo(
		() =>
			comparedReport
				? compareReports(
						comparedId,
						runId,
						comparedReport as unknown as Record<string, unknown>,
						report as unknown as Record<string, unknown>
					)
				: null,
		[comparedId, comparedReport, runId, report]
	);

	if (isRunNotFound(comparedRunError)) {
		return (
			<ErrorState
				title="This run no longer exists"
				detail="It was deleted from History. Pick another run to compare."
			/>
		);
	}
	if (reportError) {
		return (
			<ErrorState
				title="Couldn't load the comparison"
				detail={reportError instanceof Error ? reportError.message : undefined}
				onRetry={() => void refetchReport()}
			/>
		);
	}
	if (!comparison) return <DetailSkeleton label="Loading comparison" rows={5} />;

	return (
		<>
			<ComparabilityWarnings warnings={comparison.comparability} />
			<div className="surface-card border border-border rounded-md bg-card overflow-hidden">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Metric</TableHead>
							{COLUMN_HEADS.map((head) => (
								<TableHead key={head}>{head}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{[
							...comparison.latency,
							...comparison.throughput,
							...comparison.reliability,
						].map((metric) => (
							<MetricRow key={metric.metric} metric={metric} />
						))}
					</TableBody>
				</Table>
			</div>
			<StatusCodeTable statusCodes={comparison.statusCodes} />
		</>
	);
}

export default function RunComparisonView({
	report,
	runId,
	requestId,
	onClose,
	runContext,
}: RunComparisonViewProps) {
	const {
		data: runsPage,
		isLoading: loadingRuns,
		error: runsError,
		refetch: refetchRuns,
	} = useRequestRunsQuery(requestId);
	const { data: baselineRun } = useBaselineRunQuery({ requestId });

	const candidates = useMemo(
		() => comparableRuns(runsPage?.data ?? [], baselineRun, runId),
		[runsPage, baselineRun, runId]
	);

	const [chosenId, setChosenId] = useState<string | null>(null);
	const defaultId =
		candidates.find((run) => run.id === baselineRun?.id)?.id ?? candidates[0]?.id ?? null;
	// A chosen run that left the list (deleted) falls back to the default.
	const comparedId =
		chosenId && candidates.some((run) => run.id === chosenId) ? chosenId : defaultId;

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3 shrink-0">
				<Button
					variant="ghost"
					size="sm"
					className="h-control-sm gap-1.5 px-2 text-xs"
					onClick={onClose}
				>
					<ArrowLeft className="size-icon-sm" aria-hidden="true" />
					Back to report
				</Button>
				<GitCompareArrows className="size-icon shrink-0 text-muted-foreground" />
				<h2 className="text-sm font-semibold text-foreground">Compare runs</h2>
				{candidates.length > 0 && (
					<Select value={comparedId ?? undefined} onValueChange={setChosenId}>
						<SelectTrigger className="ml-auto w-72" aria-label="Compared run">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{candidates.map((run) => (
								<SelectItem key={run.id} value={run.id}>
									{runOptionLabel(run)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</div>

			<ScrollArea className="flex-1">
				<div className="flex flex-col gap-4 p-6">
					{runContext}
					{loadingRuns && <DetailSkeleton label="Loading runs" rows={3} />}
					{runsError && (
						<ErrorState
							title="Couldn't load the runs of this request"
							detail={runsError instanceof Error ? runsError.message : undefined}
							onRetry={() => void refetchRuns()}
						/>
					)}
					{!loadingRuns && !runsError && !comparedId && (
						<EmptyState
							icon={GitCompareArrows}
							title="No other runs to compare"
							description="Run this request again, or wait for a running load test to finish."
						/>
					)}
					{comparedId && (
						<ComparisonPanel comparedId={comparedId} runId={runId} report={report} />
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
