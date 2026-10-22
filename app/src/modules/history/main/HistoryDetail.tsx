/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoryDetail Component
 *
 * The run tab. Routes to `DesignRunView` (an editable copy of the request that
 * was sent) or `LoadTestDetail` (the load-test report) by run type.
 *
 * It fetches the **run**, not only the report, because the two endpoints answer
 * different questions. `GET /runs/:id/report` is a load-test aggregate: run it
 * against a design run and the percentiles all come from one sample, and
 * `metadata.configuration` is missing entirely - so it cannot say what a design
 * run's auth, scripts or redirect settings were. `GET /runs/:id` can, and for a
 * design run it also carries the stored exchange. The report is therefore
 * fetched only for a load run, and only once it has finished: a run still
 * executing shows `LoadRunInProgress` instead.
 *
 * The header deliberately does not show the URL. `DesignRunView` renders the
 * builder's own URL bar directly below it, and two URL bars stacked one above
 * the other read as a bug. What stays is the run's identity - the request's name
 * (the collection's for a sequence, the type when neither is known), its start
 * time and status - and the run's own comment (#2270). The run id is a small
 * copyable detail beneath, not the title: it names nothing a reader can tell
 * runs apart by.
 */

import { Check, Copy, History } from "lucide-react";
import { useCollectionsQuery, useRunQuery, useRunReportQuery, isRunNotFound } from "@/queries";
import { isRunInProgress } from "@/lib/run-status";
import { loadedRunReference } from "@/lib/run-reference-input";
import { useCopy } from "@/hooks/useCopy";
import { useTabsStore } from "@/stores";
import { Button, IconSwap, TooltipIconButton } from "@/components/ui";
import {
	EmptyState,
	ErrorState,
	DetailSkeleton,
	RunComment,
	RunStatusPill,
} from "@/components/shared";
import { TimeValue } from "@/components/shared/TimeValue";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import { runComment, runTitle } from "./run-heading";
import LoadTestDetail from "./LoadTestDetail";
import DesignRunView from "./DesignRunView";
import ScenarioRunView from "./ScenarioRunView";
import LoadRunInProgress from "./components/LoadRunInProgress";
import RunExportMenu from "./components/RunExportMenu";

/**
 * The run's type and id, small and mono, with the id copyable. The type shows
 * only where the title is not already it ("Load test" over "Load test" says
 * nothing), so a request's name never hides what kind of run this is.
 */
function RunIdLine({ runId, typeName }: { runId: string; typeName: string | null }) {
	const { copy, copied } = useCopy({ feedback: "icon" });
	return (
		<div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
			{typeName && <span className="shrink-0">{typeName} &middot;</span>}
			<span className="min-w-0 truncate font-mono">{runId}</span>
			<TooltipIconButton
				label="Copy run ID"
				className="size-control-sm shrink-0"
				onClick={() => void copy(runId, "Run ID")}
				icon={
					<IconSwap
						state={copied ? "copied" : "copy"}
						icons={{
							copy: <Copy className="size-icon-sm" aria-hidden="true" />,
							copied: (
								<Check
									className="size-icon-sm text-success-text"
									aria-hidden="true"
								/>
							),
						}}
					/>
				}
			/>
		</div>
	);
}

export default function HistoryDetail() {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const closeTab = useTabsStore((s) => s.closeTab);
	const { data: collections = [] } = useCollectionsQuery();
	const { copy } = useCopy();

	// Get selectedRunId from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRunId = activeTab?.type === "run" ? activeTab.entityId : null;

	const {
		data: run,
		isLoading: loadingRun,
		error: runError,
		refetch: refetchRun,
	} = useRunQuery(selectedRunId);

	const isDesignRun = run?.type === "design";
	const isScenarioRun = run?.type === "scenario";

	/*
	 * Only a **load** run's report is fetched here, and gated on below.
	 *
	 * A scenario run has a report too, but this pane must not wait for it: while
	 * the sequence is still executing, the live `step` stream is the content, and
	 * blocking on a report that does not describe a finished run yet would leave
	 * the tab on a skeleton for the length of the run. `ScenarioRunView` asks for
	 * the report itself, through the same query key, and renders around whatever
	 * has arrived.
	 */
	const isLoadRun = !!run && !isDesignRun && !isScenarioRun;
	/*
	 * A load run the engine is still executing has a report, but not a result:
	 * the numbers are the requests so far, and caching them is what froze this
	 * tab on a half-finished run (#1934). Nothing is fetched until the run
	 * ends; `runDetailOptions` polls the run's status, so this flips to the
	 * report without the tab being closed.
	 */
	const isLoadRunInProgress = isLoadRun && isRunInProgress(run.status);
	const showsReport = isLoadRun && !isLoadRunInProgress;
	const {
		data: report,
		isLoading: loadingReport,
		error: reportError,
		refetch: refetchReport,
	} = useRunReportQuery(showsReport ? selectedRunId : null, run?.status);

	// No run selected
	if (!selectedRunId) {
		return (
			<EmptyState
				icon={History}
				title="No run selected"
				description="Pick a run from the sidebar to see its results."
			/>
		);
	}

	// Loading state. A skeleton rather than a spinner, matching every other
	// detail pane: it holds the shape of the header that is about to land
	// instead of only saying "busy".
	if (loadingRun || (showsReport && loadingReport)) {
		return <DetailSkeleton label="Loading run report" rows={5} />;
	}

	// Error state. Previously a hand-rolled pane whose only action was "Back to
	// History" - it walked the user away from the run instead of offering the
	// one thing that might work, a retry. A transient engine hiccup left no way
	// back in short of re-selecting the run.
	//
	// A deleted run is the other case entirely, and the tab strip is where it
	// arrives from: tabs persist, so a run deleted in another window (or before
	// the last quit) rehydrates into this pane on launch. Retrying a 404 can
	// only fail again, so that one offers the move that works instead.
	if (runError || !run) {
		if (isRunNotFound(runError)) {
			return (
				<ErrorState
					title="This run no longer exists"
					detail="It was deleted from History. Nothing here can be recovered - closing the tab is safe."
					action={
						activeTab ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => closeTab(activeTab.id)}
							>
								Close tab
							</Button>
						) : undefined
					}
				/>
			);
		}
		const detail = runError instanceof Error ? runError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run"
				detail={detail ?? "Vayu's engine returned nothing for this run."}
				onRetry={() => void refetchRun()}
			/>
		);
	}

	if (showsReport && (reportError || !report)) {
		const detail = reportError instanceof Error ? reportError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run"
				detail={detail ?? "Vayu's engine returned no report for this run."}
				onRetry={() => void refetchReport()}
			/>
		);
	}

	const typeName = RUN_TYPE_NAME[run.type];
	const title = runTitle(run, collections);

	return (
		<div className="flex flex-col h-full bg-background">
			{/*
			 * Run identity header. No back button: this is a tab, closed from the
			 * tab strip, and History lives in the left nav. The old "Back to
			 * history" only called activateDrawerView("history"), which toggled the
			 * drawer open/closed rather than navigating anywhere.
			 */}
			<div className="border-b border-border bg-card px-6 py-3 shrink-0">
				<div className="flex items-center gap-3">
					<div className="flex-1 min-w-0 flex items-center gap-2">
						<h1
							className="min-w-0 truncate text-sm font-semibold text-foreground"
							title={title}
						>
							{title}
						</h1>
						<RunStatusPill status={run.status} />
						<TimeValue
							value={run.startTime}
							className="shrink-0 text-xs text-muted-foreground"
						/>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="h-control-sm shrink-0 gap-1.5 px-2 text-xs"
						onClick={() => void copy(loadedRunReference(run, collections), "Reference")}
					>
						<Copy className="size-icon-sm" aria-hidden="true" />
						Copy for agent
					</Button>
					{/* A finished load run only: the engine exports nothing else. */}
					{showsReport && (
						<RunExportMenu
							runId={selectedRunId}
							requestUrl={report?.metadata?.requestUrl}
							requestMethod={report?.metadata?.requestMethod}
						/>
					)}
				</div>
				<RunIdLine runId={selectedRunId} typeName={title === typeName ? null : typeName} />
				<RunComment comment={runComment(run)} className="mt-1" />
			</div>
			{/* Detail Content */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{/* Keyed on the run: these views hold per-run local state (active
				    tab, filters, dialogs) that must not carry over to the next run. */}
				{isDesignRun ? (
					<DesignRunView key={selectedRunId} run={run} />
				) : isScenarioRun ? (
					<ScenarioRunView key={selectedRunId} run={run} />
				) : isLoadRunInProgress ? (
					<LoadRunInProgress runId={selectedRunId} />
				) : (
					<LoadTestDetail key={selectedRunId} report={report!} runId={selectedRunId} />
				)}
			</div>
		</div>
	);
}
