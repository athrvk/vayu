/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ScenarioRunView
 *
 * The run tab for a collection run: what the sequence did, step by step.
 *
 * **Not `LoadTestDetail`.** A scenario run's `results[]` are step executions of
 * *different* requests, so the load report's percentiles and status
 * distribution would describe a sequence as though it were one request
 * repeated. The number a reader wants here is per step, and the four outcomes.
 *
 * **Two sources, one list** (see `scenario-steps.ts`). While the run streams,
 * rows come from the `step` SSE events; once it is over, from the stored
 * `results` rows, which are the ones carrying an exchange to expand. The
 * changeover is the stream closing: `ScenarioRunService` refetches the report
 * on `complete`, and this view prefers stored rows the moment there are any.
 *
 * That preference is also what keeps a re-opened tab honest. A completed run
 * reopened later has no live steps at all and reads entirely from storage -
 * including the disclosure that storage is not the whole run.
 *
 * **The list is bounded in cost, not in content** (issue #730).
 * `maxScenarioStoredSteps` is 5,000, and every one of them used to mount as a
 * card. Two things keep that usable and neither drops a step: the four count
 * chips are buttons that filter by outcome - the reader after a failure wants
 * the failures, and the numbers were already sitting there - and the rows
 * arrive through `useGrowingWindow`, the same growing list the response pane's
 * console output uses, rather than a virtualiser this repo would then have to
 * maintain a scroll map for.
 */

import { useMemo, useState } from "react";
import { ListOrdered, Loader2 } from "lucide-react";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { useRunReportQuery } from "@/queries";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import { useScenarioRunStore, useToastStore } from "@/stores";
import { Badge } from "@/components/ui";
import {
	ContractCoverage,
	EmptyState,
	Callout,
	SampledSchemaValidation,
	StopRunButton,
	StoredExchangeWarning,
} from "@/components/shared";
import { cn } from "@/lib/utils";
import ScenarioStepCard from "./components/ScenarioStepCard";
import {
	countOutcomes,
	outcomeCountsFromReport,
	stepKey,
	stepRowsFromReport,
	thinningDisclosure,
	type ScenarioStepRow,
} from "./scenario-steps";
import type { Run, StepOutcome } from "@/types";
import { STEP_OUTCOMES } from "@/types";

interface ScenarioRunViewProps {
	run: Run;
}

/**
 * A stable empty array for the not-this-run case. A fresh `[]` per selector
 * call is a new reference every time, and zustand's default equality would then
 * re-render this view on every unrelated store write.
 */
const EMPTY_STEPS: ScenarioStepRow[] = [];

/**
 * Chip tint per outcome, matching the step rows.
 *
 * `skipped` has its own entry rather than sharing `passed`'s: the whole point
 * of the four-number summary is that a step which never ran is not a pass.
 */
const COUNT_CHIP: Record<StepOutcome, string> = {
	passed: "bg-status-success-fill text-white",
	failed: "bg-status-error-fill text-white",
	skipped: "bg-muted text-muted-foreground",
	errored: "bg-status-error-fill text-white",
};

export default function ScenarioRunView({ run }: ScenarioRunViewProps) {
	const { data: report, isLoading } = useRunReportQuery(run.id);

	// The live steps belong to this run only. The store holds one run at a
	// time, so a tab for an older run must read an empty list rather than the
	// steps of whatever is streaming now.
	const liveSteps = useScenarioRunStore((s) => (s.runId === run.id ? s.steps : EMPTY_STEPS));
	const isStreaming = useScenarioRunStore((s) => s.runId === run.id && s.isStreaming);
	const streamError = useScenarioRunStore((s) => (s.runId === run.id ? s.error : null));

	const storedSteps = useMemo(() => stepRowsFromReport(report), [report]);
	const steps = storedSteps.length > 0 ? storedSteps : liveSteps;

	// The report's exact whole-run totals when it can give them, the stored rows
	// only as a fallback. A thinned run keeps every non-passing row but drops
	// passes, so counting rows would undercount `passed` against the header's own
	// step total - the report is the one source that agrees with it (issue #726).
	// A live run has no report yet and reads its streaming rows until one lands.
	const counts = useMemo(
		() => outcomeCountsFromReport(report) ?? countOutcomes(steps),
		[report, steps]
	);
	const thinned = thinningDisclosure(report);
	const scenario = report?.scenario;

	const inProgress = run.status === "running" || run.status === "pending";

	/*
	 * Stoppable while the engine still owns the run, and that is two signals
	 * rather than one. The stream says so for the tab that started the run; the
	 * run's own status says so for a tab reopened onto a run that is still
	 * executing - after a relaunch, or from History - which has no stream at all
	 * and is exactly the case where waiting the run out hurts most.
	 */
	const isLive = isStreaming || inProgress;

	const showToast = useToastStore((s) => s.showToast);
	const [isStopping, setIsStopping] = useState(false);

	const handleStop = async () => {
		setIsStopping(true);
		try {
			await apiService.stopRun(run.id);
			/*
			 * The streaming tab hears this again through `complete`: the engine
			 * drives a stopped scenario to a terminal status and closes the
			 * topic, and `ScenarioRunService` refreshes the run and its report on
			 * close. A tab that is *not* attached to the stream gets no such
			 * event, so without this its run would sit on "running" - still
			 * offering a Stop for something already stopped, and never loading
			 * the step rows the run just wrote.
			 */
			await queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(run.id) });
			await queryClient.invalidateQueries({ queryKey: queryKeys.runs.report(run.id) });
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		} catch (error) {
			// The run keeps executing and the button comes back, so without this
			// a click that failed is indistinguishable from one that did nothing.
			console.error("Failed to stop scenario run:", error);
			showToast({
				message: error instanceof Error ? error.message : "Couldn't stop the run",
				variant: "error",
				// The sequence is still sending requests, so the retry is the
				// reason for telling them at all.
				action: {
					label: "Try again",
					altText: "Try stopping the run again",
					onClick: () => void handleStop(),
				},
			});
		} finally {
			setIsStopping(false);
		}
	};

	// One iteration is the common case and "Iteration 1" on every row is noise;
	// more than one and which pass a step belongs to is the whole point.
	const showIteration = steps.some((s) => s.iteration > 0);

	// A run bound a data set if any step says which row it took. Read off the
	// steps rather than the report so the sentence is right for a live run too -
	// the `step` events carry `dataRowIndex` exactly as the stored rows do.
	const dataBound = steps.some((s) => s.dataRowIndex !== undefined);

	const [expanded, setExpanded] = useState<string | null>(null);
	const toggle = (step: ScenarioStepRow) => {
		const key = stepKey(step);
		setExpanded((current) => (current === key ? null : key));
	};

	/*
	 * Which outcome the list is showing, or all of them (issue #730).
	 *
	 * The chips above are the control rather than a filter bar beside them: the
	 * four numbers a reader already reads to find out that eleven steps failed
	 * are the same four they then want the list narrowed to. Held here and not
	 * in the URL or the store - it is a way of looking at this tab, and a
	 * remembered one would hide steps from the next reader of it.
	 */
	const [outcomeFilter, setOutcomeFilter] = useState<StepOutcome | null>(null);
	const shownSteps = useMemo(
		() => (outcomeFilter === null ? steps : steps.filter((s) => s.outcome === outcomeFilter)),
		[steps, outcomeFilter]
	);

	/*
	 * The rows arrive as the list is scrolled - see the header note. Nothing is
	 * withheld: `hasMore` drives a line saying how many are still to come, and
	 * reaching the sentinel renders the next slice.
	 */
	const { visible, sentinelRef, hasMore } = useGrowingWindow(shownSteps.length);
	const rendered = shownSteps.slice(0, visible);

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* No run identity here - `HistoryDetail` prints the id, the type and
			    the status directly above. This bar is what that header cannot
			    say: what the sequence did. */}
			<header className="flex flex-wrap items-center gap-3 px-5 py-3 bg-panel border-b border-border shrink-0">
				{isStreaming && (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
						Running
					</span>
				)}

				{scenario && (
					<span className="text-xs text-muted-foreground">
						{scenario.iterationsCompleted} of {scenario.iterations} iteration
						{scenario.iterations === 1 ? "" : "s"} - {scenario.stepsExecuted} step
						{scenario.stepsExecuted === 1 ? "" : "s"}
					</span>
				)}

				{/* All four, always, including the zeros. A summary that hides the
				    outcomes nobody hit reads differently run to run, and the point
				    of the row is that these are four separate numbers.

				    Each is also the filter for its own outcome (issue #730): a
				    reader who has just read "11 failed" wants those eleven, and
				    the number is where they read it. Pressing the active one
				    clears the filter, so the control says what it does and undoes
				    it in the same place. */}
				<span className="flex items-center gap-1.5 sm:ml-auto">
					{STEP_OUTCOMES.map((outcome) => {
						const isActive = outcomeFilter === outcome;
						return (
							<button
								key={outcome}
								type="button"
								aria-pressed={isActive}
								aria-label={`Show only ${outcome} steps`}
								onClick={() =>
									setOutcomeFilter((current) =>
										current === outcome ? null : outcome
									)
								}
								/* The ring rather than a tint change: the chip's own
								   colour is what identifies the outcome, and dimming
								   or brightening it would make "filtered" read as a
								   different outcome. */
								className={cn(
									"rounded-md transition-opacity",
									isActive
										? "ring-2 ring-primary ring-offset-1 ring-offset-panel"
										: "opacity-90 hover:opacity-100"
								)}
							>
								<Badge
									variant="chip"
									className={cn("shrink-0", COUNT_CHIP[outcome])}
									data-outcome-count={outcome}
								>
									{counts[outcome]} {outcome}
								</Badge>
							</button>
						);
					})}
				</span>

				{/* Last, and only while the run is live. A terminal run has
				    nothing to stop, and a Stop that lingers on a finished run
				    reads as a run that never ended. */}
				{isLive && (
					<StopRunButton onStop={() => void handleStop()} isStopping={isStopping} />
				)}
			</header>

			<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
				{streamError && (
					<Callout severity="warning" title="Live updates stopped">
						{streamError} The run itself is unaffected - reopen this tab once it
						finishes to read its stored steps.
					</Callout>
				)}

				{thinned && (
					<Callout severity="info" title="Bounded step storage">
						This run executed {thinned.stepsExecuted.toLocaleString()} steps and kept{" "}
						{thinned.stepsStored.toLocaleString()}. The{" "}
						{thinned.stepsDropped.toLocaleString()} not listed were successes - every
						step that did not pass was kept. Raise <code>maxScenarioStoredSteps</code>{" "}
						in Settings to keep more.
					</Callout>
				)}

				{/* What the rows below are, before a reader starts opening them:
				    each one holds its request and response as they went over the
				    wire. The load-mode sibling of this notice sits over the
				    Samples tab, and a collection run's steps are the surface that
				    had none - which let the Data tab's "rows are never saved
				    anywhere" be read as covering the cells those rows bound
				    (issue #731). */}
				<StoredExchangeWarning steps={steps.length} dataBound={dataBound} />

				{/* Above the steps rather than after them: "which of the contract
				    did this run exercise" is a whole-run answer, and a reader
				    who has to scroll past forty step cards to reach it will not.
				    Absent for a run of a collection bound to nothing. */}
				<ContractCoverage
					coverage={report?.coverage}
					inheritedBinding={report?.metadata?.openapi?.inherited}
				/>

				{/* And whether what came back honoured it - the same whole-run
				    answer, so it sits under coverage here exactly as it does in
				    the history detail's Overview. Absent on the same terms. */}
				<SampledSchemaValidation validation={report?.schemaValidation} />

				{steps.length === 0 ? (
					/*
					 * "Nothing yet" and "nothing at all" are different answers,
					 * and the run's own status is what tells them apart. The
					 * stream is not enough on its own: a tab reopened onto a run
					 * that is still executing - after a relaunch, or from
					 * History - has no live steps and no stored ones either, and
					 * telling that reader the run recorded nothing would be
					 * wrong about a run that is still going.
					 */
					isLoading || isStreaming || inProgress ? (
						<EmptyState
							icon={Loader2}
							title="Waiting for the first step"
							description="Steps appear here as the run executes them."
						/>
					) : (
						<EmptyState
							icon={ListOrdered}
							title="No steps recorded"
							description="This run stored no step results."
						/>
					)
				) : outcomeFilter !== null && shownSteps.length === 0 ? (
					/*
					 * Filtered to an outcome that no *stored* row has. Not the same
					 * as "no such steps": thinning keeps every non-passing row and
					 * drops passes, so a 6,000-step run can report 5,010 passed and
					 * hold none of them. The chip's number is the run's, this list
					 * is the store's, and saying which is which is the difference
					 * between a disclosure and a contradiction.
					 */
					<EmptyState
						icon={ListOrdered}
						title={`No ${outcomeFilter} steps in the stored rows`}
						description={
							thinned
								? "This run's step store filled and dropped successes - the chip counts the whole run, this list holds what was kept."
								: "The chip above counts the whole run; these rows are what it stored."
						}
					/>
				) : (
					<>
						{rendered.map((step) => (
							/*
							 * `skip-offscreen` per card, sized for a card rather
							 * than for a console line: the browser skips layout and
							 * paint for the ones scrolled past, which is what keeps
							 * a filled store's list responsive after it has grown.
							 */
							<div
								key={stepKey(step)}
								className="skip-offscreen [--skip-offscreen-size:3.5rem]"
							>
								<ScenarioStepCard
									step={step}
									showIteration={showIteration}
									isExpanded={expanded === stepKey(step)}
									onToggle={() => toggle(step)}
									runId={run.id}
								/>
							</div>
						))}
						{hasMore && (
							/*
							 * The sentinel. Reaching it renders the next slice -
							 * nothing is withheld, it arrives when you get there.
							 * The count is stated rather than left to be inferred
							 * from a scrollbar, exactly as the console's is.
							 */
							<p
								ref={sentinelRef}
								className="px-1 py-2 text-xs text-muted-foreground"
							>
								Showing {rendered.length.toLocaleString()} of{" "}
								{shownSteps.length.toLocaleString()} steps - scroll for more.
							</p>
						)}
					</>
				)}
			</div>
		</div>
	);
}
