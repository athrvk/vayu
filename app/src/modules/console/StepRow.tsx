/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection-run step in the session Console (#3634): drawn live from its
 * `step` frame, which is constant-size and carries no exchange, and expanded
 * from the step's stored row - the run's report, read through the query
 * History's run view reads, matched on iteration and position.
 *
 * The expansion is in the order the step ran: the pre-request script's lines
 * and requests (`details`), the timing and the exchange, then the post-request
 * script's. The report is asked for only while the row is open, and a run that
 * is still streaming has stored nothing yet, which the row says rather than
 * opening onto an empty box; the run service invalidates the report when the
 * run ends, so an open row fills in then.
 */

import { memo, useMemo, type ReactNode } from "react";
import { Badge, Button } from "@/components/ui";
import { MethodBadge } from "@/components/shared/MethodBadge";
import { TimeValue } from "@/components/shared/TimeValue";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { SampledExchange, phasesFromTrace } from "@/components/shared/response-viewer";
import { formatBytes } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { useRunReportQuery } from "@/queries/runs";
import { useScenarioRunStore } from "@/stores";
import type { ConsoleRow, ConsoleStepRow } from "@/stores/console-store";
import type { RunReport } from "@/types";
import { stepRowsFromReport, type ScenarioStepRow } from "@/modules/history/main/scenario-steps";
import {
	STEP_OUTCOME_CHIP,
	STEP_OUTCOME_STATE,
	stepWasAnswered,
} from "@/modules/history/main/step-outcome";
import { consoleRows } from "@/modules/request-builder/components/ResponseViewer/console/console-rows";
import {
	parseConsoleLogs,
	splitBySource,
} from "@/modules/request-builder/components/ResponseViewer/console/parse-logs";
import {
	ScriptError,
	ScriptLogs,
} from "@/modules/request-builder/components/ResponseViewer/console/ScriptSection";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import type { ResponseState } from "@/modules/request-builder/types";
import { maskedExchange } from "./console-rows";
import { ExchangeView } from "./ExchangeView";
import { OpenRunButton } from "./RowActions";

type StepRowData = ConsoleRow & ConsoleStepRow;

/** The stored row of the step @p row stands for, if the report holds one. */
function storedStep(report: RunReport | undefined, row: StepRowData): ScenarioStepRow | undefined {
	return stepRowsFromReport(report).find(
		(stored) => stored.iteration === row.iteration && stored.stepIndex === row.stepIndex
	);
}

function Note({ children }: { children: ReactNode }) {
	return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** The step's script output split at the request, each half in the response pane's own section. */
function useScriptHalves(response: ResponseState | null) {
	return useMemo(() => {
		if (!response) return null;
		const rows = consoleRows(
			parseConsoleLogs(response.consoleLogs ?? []),
			response.scriptRequests
		);
		return splitBySource(rows);
	}, [response]);
}

/** Why an open row shows no exchange yet: loading, a failed read, or nothing stored. */
function PendingDetail({
	runId,
	isLoading,
	error,
	retry,
}: {
	runId: string;
	isLoading: boolean;
	error: Error | null;
	retry: () => void;
}) {
	const live = useScenarioRunStore((s) => s.runId === runId && s.isStreaming);
	if (isLoading) return <Note>Reading this step from History…</Note>;
	if (error) {
		return (
			<div role="alert" className="flex items-center gap-2 text-xs">
				<span className="text-status-error-text">
					Couldn&apos;t read this step from History - {error.message}
				</span>
				<Button type="button" variant="link" size="sm" onClick={retry}>
					Try again
				</Button>
			</div>
		);
	}
	if (live) {
		return (
			<Note>
				The request and response appear here once the run finishes - steps are stored when
				it ends.
			</Note>
		);
	}
	return <Note>History has no stored copy of this step.</Note>;
}

function StepTitle({ row }: { row: StepRowData }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span className="shrink-0 text-sm text-foreground">{row.name}</span>
			<Badge variant="chip" className={cn("shrink-0", STEP_OUTCOME_CHIP[row.outcome])}>
				{row.outcome}
			</Badge>
			{row.method && <MethodBadge method={row.method} />}
			{row.url && (
				<TruncatedText className="min-w-0 font-mono text-xs text-foreground">
					{row.url}
				</TruncatedText>
			)}
		</span>
	);
}

interface StepRowProps {
	row: StepRowData;
	isExpanded: boolean;
	onToggle: (id: number) => void;
}

export const StepRow = memo(function StepRow({ row, isExpanded, onToggle }: StepRowProps) {
	const report = useRunReportQuery(isExpanded ? row.runId : null);
	const stored = useMemo(() => storedStep(report.data, row), [report.data, row]);
	const result = stored?.result;
	const response = useMemo(
		() => (result ? responseFromRunResult(result, row.runId) : null),
		[result, row.runId]
	);
	const halves = useScriptHalves(response);
	const exchange = useMemo(() => (response ? maskedExchange(response) : null), [response]);
	const answered = stepWasAnswered(row.outcome);

	const preScriptRan = !!response?.preScriptError || (halves?.pre.length ?? 0) > 0;

	return (
		<SampledExchange
			label={row.id}
			title={<StepTitle row={row} />}
			state={STEP_OUTCOME_STATE[row.outcome]}
			statusCode={answered ? row.status : undefined}
			latencyMs={answered ? row.timeMs : undefined}
			timestamp={
				<span className="tabular-nums">
					{row.sizeBytes !== undefined && `${formatBytes(row.sizeBytes)} · `}
					<TimeValue value={row.at} style="time-ms" />
				</span>
			}
			// A stopped step's stored error is the cancel, which its chip already says.
			error={row.outcome === "stopped" ? undefined : result?.error}
			details={
				preScriptRan && (
					<>
						{response?.preScriptError && (
							<ScriptError which="pre" message={response.preScriptError} />
						)}
						{halves && <ScriptLogs which="pre" logs={halves.pre} />}
					</>
				)
			}
			phases={phasesFromTrace(result?.trace)}
			scriptMs={result?.trace?.scriptMs}
			isExpanded={isExpanded}
			onToggle={() => onToggle(row.id)}
			actions={<OpenRunButton runId={row.runId} />}
		>
			{!stored && (
				<PendingDetail
					runId={row.runId}
					isLoading={report.isLoading}
					error={report.error}
					retry={() => void report.refetch()}
				/>
			)}
			{stored && !exchange && <Note>This step recorded no exchange.</Note>}
			{exchange && <ExchangeView exchange={exchange} />}
			{response?.postScriptError && (
				<ScriptError which="test" message={response.postScriptError} />
			)}
			{halves && <ScriptLogs which="test" logs={halves.test} />}
		</SampledExchange>
	);
});
