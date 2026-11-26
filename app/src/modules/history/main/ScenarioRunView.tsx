/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run tab for a collection run: what the sequence did, step by step.
 *
 * **Not `LoadTestDetail`.** A scenario run's `results[]` are step executions of *different*
 * requests, so the load report's percentiles and status distribution would describe a sequence as
 * one request repeated. The numbers wanted here are per step, and the outcomes.
 *
 * **Two sources, one list** (see `scenario-steps.ts`). While the run streams, rows come from the
 * `step` SSE events; once it is over, from the stored `results` rows, which carry an exchange to
 * expand. The changeover is the stream closing: `ScenarioRunService` refetches the report on
 * `complete`, and this view prefers stored rows as soon as there are any. That preference also
 * keeps a reopened tab honest: a completed run reopened later has no live steps and reads entirely
 * from storage, including the disclosure that storage is not the whole run.
 *
 * **The list is bounded in cost, not in content** (#730). `maxScenarioStoredSteps` is 5,000. Two
 * things keep that usable and neither drops a step: the four count chips are buttons that filter by
 * outcome (the reader after a failure wants the failures), and the rows arrive through a growing
 * window, the one the response pane's console output uses (`useGrowingWindow`, held here by
 * `useFilteredSteps`), rather than a virtualiser this repo would have to maintain a scroll map for.
 *
 * **Two controls, one predicate** (#832). The chips narrow by outcome and the search box by step
 * name, and `filterSteps` applies both at once: "the failed executions of `POST /checkout`" is a
 * question neither answers alone, as a run's failures spread across a dozen steps and a name
 * repeats once per iteration. One predicate also means one empty state, naming whichever
 * combination emptied the list. A live run runs the predicate over the batch that just arrived, not
 * the whole run per commit, and produces only as many rows as the window shows (`useFilteredSteps`
 * keeps what it has matched; #1205, #1297).
 */

import { useCallback, useMemo, useState } from "react";
import { ListOrdered, Loader2, Search } from "lucide-react";
import { useRunReportQuery } from "@/queries";
import { useStopRun } from "@/hooks/useStopRun";
import { useRunLiveness } from "@/hooks/useRunLiveness";
import { dataFileDisplayName, dataFileNote } from "@/lib/run-data-file";
import { formatNumber } from "@/lib/format-number";
import { useDataFileStatus } from "@/hooks/useDataFileStatus";
import { scenarioFromSnapshot } from "@/components/layout/context-bar/run-scenario";
import { useScenarioRunStore } from "@/stores";
import { Badge, Input } from "@/components/ui";
import {
	ContractCoverage,
	EmptyState,
	Callout,
	SampledSchemaValidation,
	ScriptLifecycleSummary,
	StopRunButton,
	StoredExchangeWarning,
	ThresholdVerdict,
	TransactionsSummary,
	stoppedRunOf,
} from "@/components/shared";
import { cn } from "@/lib/utils";
import ScenarioStepCard from "./components/ScenarioStepCard";
import { NotNegotiated } from "./components/RunConfigSummary";
import { finishedRunFiguresText, liveRunProgressText } from "./scenario-run-header";
import {
	emptyStepListReason,
	emptyStepSummary,
	outcomeCountsFromReport,
	stepKey,
	stepRowsFromReport,
	stepsNotRunText,
	summarizeSteps,
	thinningDisclosure,
	type ScenarioStepRow,
	type StepListSummary,
} from "./scenario-steps";
import { useFilteredSteps } from "./useFilteredSteps";
import type { Run, StepOutcome } from "@/types";
import { STEP_OUTCOMES } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";

interface ScenarioRunViewProps {
	run: Run;
}

/**
 * A stable empty array for the not-this-run case. A fresh `[]` per selector
 * call is a new reference every time, and zustand's default equality would then
 * re-render this view on every unrelated store write.
 */
const EMPTY_STEPS: ScenarioStepRow[] = [];

/** The same, for the summary beside them - a fresh one per call re-renders too. */
const EMPTY_SUMMARY: StepListSummary = emptyStepSummary();

/**
 * Chip tint per outcome, matching the step rows. `skipped` has its own entry, not `passed`'s: the
 * point of the summary is that a step which never ran is not a pass.
 */
const COUNT_CHIP: Record<StepOutcome, string> = {
	passed: "bg-status-success-fill text-white",
	failed: "bg-status-error-fill text-white",
	skipped: "bg-muted text-muted-foreground",
	errored: "bg-status-error-fill text-white",
	stopped: "bg-status-stopped-fill text-white",
};

/**
 * Whether `outcome`'s count chip is drawn: the first four always, zeros included, `stopped` only
 * for a run a Stop cut short (#3397), as "0 stopped" on nearly every run is noise. It stays while
 * it is the active filter, so the pressed control never vanishes under the reader.
 */
function showsCountChip(outcome: StepOutcome, count: number, isActive: boolean): boolean {
	return outcome !== "stopped" || count > 0 || isActive;
}

export default function ScenarioRunView({ run }: ScenarioRunViewProps) {
	const { data: report, isLoading } = useRunReportQuery(run.id);

	// The live steps belong to this run only: the store holds one run at a time, so an older run's
	// tab reads an empty list, not the steps of whatever is streaming now.
	const liveSteps = useScenarioRunStore((s) => (s.runId === run.id ? s.steps : EMPTY_STEPS));
	const liveSummary = useScenarioRunStore((s) =>
		s.runId === run.id ? s.summary : EMPTY_SUMMARY
	);
	// Which live list this is, for the filter that has to know whether the rows
	// it matched are still the rows below the ones that just arrived. A tab that
	// is not the streaming run reads `EMPTY_STEPS`: nothing has been matched
	// from an empty list, so the value it reads here cannot carry anything over.
	const liveAppendEpoch = useScenarioRunStore((s) => (s.runId === run.id ? s.appendEpoch : 0));
	const isStreaming = useScenarioRunStore((s) => s.runId === run.id && s.isStreaming);
	const streamError = useScenarioRunStore((s) => (s.runId === run.id ? s.error : null));
	const endedByEngineStop = useScenarioRunStore((s) => s.runId === run.id && s.endedByEngineStop);
	const livePlan = useScenarioRunStore((s) => (s.runId === run.id ? s.plan : null));

	const storedSteps = useMemo(() => stepRowsFromReport(report), [report]);
	const usingStored = storedSteps.length > 0;
	const steps = usingStored ? storedSteps : liveSteps;

	/*
	 * What the header asks of the whole list, without reading the whole list. The stored rows
	 * arrive complete and change only with the report, so one pass per report answers for them. The
	 * live rows arrive a batch at a time with their summary, folded by the store as they land
	 * (#1153), because a pass per commit is a pass over a list that grows for the length of the
	 * run.
	 */
	const storedSummary = useMemo(() => summarizeSteps(storedSteps), [storedSteps]);
	const summary = usingStored ? storedSummary : liveSummary;

	// The report's exact whole-run totals when it can give them, the rows on screen only as a
	// fallback. A thinned run keeps every non-passing row but drops passes, so counting rows would
	// undercount `passed` against the header's own step total; the report is the one source that
	// agrees with it (#726). A live run reads its streaming rows until a report lands.
	const counts = useMemo(
		() => outcomeCountsFromReport(report) ?? summary.counts,
		[report, summary]
	);
	const thinned = thinningDisclosure(report);
	const scenario = report?.scenario;
	const notRun = stepsNotRunText(scenario?.stepsNotRun);

	/*
	 * Stoppable while the engine still owns the run, which takes two signals: the stream for the
	 * tab that started the run, and the run's status for a tab reopened onto a run still executing
	 * (after a relaunch, or from History), which has no stream and is where waiting the run out
	 * hurts most.
	 */
	const isLive = useRunLiveness(run.id, run.status);

	const { stop, isStopping } = useStopRun(run.id);

	// While live, where the run is against its plan; once it has ended, what it
	// did. Never both: the report of a run still in flight holds no final figures.
	const liveProgress = isLive
		? liveRunProgressText(
				livePlan,
				steps[steps.length - 1],
				STEP_OUTCOMES.reduce((total, outcome) => total + summary.counts[outcome], 0)
			)
		: null;
	const finishedFigures =
		!isLive && report && scenario ? finishedRunFiguresText(report.summary) : null;
	// Steps that asked for HTTP/2 and ran on something older (#3262). 0 and absent
	// both draw nothing, as in `LoadTestDetail`.
	const downgradedRequests = (!isLive && report?.summary.httpVersionDowngraded) || 0;

	// One iteration is the common case and "Iteration 1" on every row is noise;
	// more than one and which pass a step belongs to is the whole point.
	const showIteration = summary.iterationSteps > 0;

	// A run bound a data set if any step says which row it took. Read off the
	// steps rather than the report so the sentence is right for a live run too -
	// the `step` events carry `dataRowIndex` exactly as the stored rows do.
	const dataBound = summary.dataBoundSteps > 0;

	// The file the run read, from its snapshot's manifest (#2051). Absent for a
	// run recorded before the field, which then prints nothing about a file.
	const manifest = useMemo(() => scenarioFromSnapshot(run), [run]);
	const dataFileName = manifest?.dataFileName;
	const dataFileStatus = useDataFileStatus(
		manifest?.collectionId,
		manifest?.dataFileHash,
		manifest?.dataFileCastNumbers
	);

	const [expanded, setExpanded] = useState<string | null>(null);
	/*
	 * One handler for every card, not one per card: `ScenarioStepCard` is memoized, and an arrow
	 * function built per row per render would hand all 200 mounted cards a new prop on every
	 * keystroke in the search box (#1153). The card passes its own step back rather than closing
	 * over it.
	 */
	const toggle = useCallback((step: ScenarioStepRow) => {
		const key = stepKey(step);
		setExpanded((current) => (current === key ? null : key));
	}, []);

	/*
	 * Which outcome the list shows, or all (#730). The chips are the control, not a filter bar
	 * beside them: the counts a reader reads to learn that eleven steps failed are the counts they
	 * then want the list narrowed to. Held here, not in the URL or the store: it is a way of
	 * looking at this tab, and a remembered one would hide steps from its next reader.
	 */
	const [outcomeFilter, setOutcomeFilter] = useState<StepOutcome | null>(null);

	/*
	 * And which step, by name (#832). The chips cannot answer "every execution of
	 * `POST /checkout`": a 5,000-step run of a 40-request collection is 40 names repeated 125
	 * times, and the failures a chip narrows to spread across a dozen steps. Held beside the chip
	 * on the same terms.
	 */
	const [query, setQuery] = useState("");
	/*
	 * Held across commits, not recomputed per commit (#1205, #1297): the store hands the view a new
	 * array per batch, and a narrowing filter would otherwise run its predicate (the search
	 * lowercasing each name) over every row produced so far. Rows already matched cannot stop
	 * matching when more arrive at the end, so `useFilteredSteps` counts the batch alone and
	 * produces only the part of the window on screen. `appendKey` tells it this is the same list,
	 * only longer, and only the store's epoch knows that (a replaced row and an appended one look
	 * alike from here). The stored rows are their own key: they arrive complete and change only
	 * with the report.
	 *
	 * It owns the growing window too, as the two are one ordering: the window is sized against the
	 * count, and the count says how far the window has to be produced. Nothing is withheld:
	 * `hasMore` drives a line saying how many are still to come, and reaching the sentinel renders
	 * the next slice.
	 *
	 * `run.id`, not the epoch, keys that window (#1153). A narrowed list is a new list and starts
	 * at its own top (the hook adds the chips and the search to the key itself); a live run's list
	 * is the *same* list growing, and resetting on its length would throw the reader back to the
	 * first 200 rows on every batch. The changeover to stored rows at run end is deliberately not
	 * in the key: the rows are the same, and snapping the window would undo a scroll as the run
	 * finished.
	 */
	const shownSteps = useFilteredSteps(
		steps,
		{ outcome: outcomeFilter, query },
		usingStored ? storedSteps : liveAppendEpoch,
		run.id
	);

	/*
	 * Both controls narrow one list, so one empty state answers for both and names whichever
	 * combination emptied it: they are cleared in different places, and a reader told "no failed
	 * steps" over a list their search emptied clears the wrong one. `null` while rows remain, and
	 * for a run that recorded nothing, which is the run's own emptiness, answered below by its
	 * status.
	 */
	const emptyReason =
		shownSteps.total === 0
			? emptyStepListReason({ outcome: outcomeFilter, query }, thinned)
			: null;

	const { rows: rendered, sentinelRef, hasMore } = shownSteps;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* No run identity here - `HistoryDetail` prints the id, the type and
			    the status directly above. This bar is what that header cannot
			    say: what the sequence did. */}
			<header className="flex flex-wrap items-center gap-3 px-5 py-3 bg-panel border-b border-border shrink-0">
				{isStreaming && (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Loader2 className="size-icon-sm animate-spin" />
						Running
					</span>
				)}

				{liveProgress && (
					<span className="text-xs text-muted-foreground">{liveProgress}</span>
				)}

				{scenario && (
					<span className="text-xs text-muted-foreground">
						{formatNumber(scenario.iterationsCompleted)} of{" "}
						{formatNumber(scenario.iterations)}{" "}
						{pluralize(scenario.iterations, "iteration")} -{" "}
						{formatNumber(scenario.stepsExecuted)}{" "}
						{pluralize(scenario.stepsExecuted, "step")}
					</span>
				)}

				{finishedFigures && (
					<span className="text-xs text-muted-foreground">{finishedFigures}</span>
				)}

				{downgradedRequests > 0 && (
					<span className="text-xs">
						<NotNegotiated count={downgradedRequests} label="HTTP/2 not negotiated" />
					</span>
				)}

				{/* A sibling, not a clause of the tally: a run that did less than
				    its plan because errors ended iterations should say so beside
				    the count of what it did, without changing that sentence
				    (issue #2526). Absent for 0 and for a report that predates it. */}
				{notRun && <span className="text-xs text-muted-foreground">{notRun}</span>}

				{dataFileName && (
					<span className="text-xs text-muted-foreground">
						Data: {dataFileDisplayName(dataFileName, manifest?.dataFileCastNumbers)}
						{dataFileNote(dataFileStatus)}
					</span>
				)}

				{/* Beside the chips rather than above the list (issue #832): the
				    two are one predicate, and a control that narrows the same
				    list from somewhere else reads as narrowing something else.
				    Full width when the bar wraps, so the field does not end up
				    a stub on a narrow tab. The placeholder names the field it
				    matches, because "search" over rows carrying a name, a URL
				    and a status code otherwise has to be guessed at. */}
				<div className="relative w-full sm:w-44">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-icon-sm -translate-y-1/2 text-muted-foreground" />
					<Input
						size="sm"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search step names"
						aria-label="Search steps by name"
						// `md:text-xs` as well as `text-xs`: the Input primitive
						// carries `md:text-sm`, and tailwind-merge keeps a
						// responsive variant in its own group - so an unqualified
						// `text-xs` loses to it above 768px.
						className="pl-7 text-xs md:text-xs"
					/>
				</div>

				{/*
				 * The first four always, zeros included: a summary hiding the outcomes nobody hit
				 * reads differently run to run, and the point is that these are separate numbers.
				 * `stopped` joins only when a Stop cut a step short. Each is also its outcome's
				 * filter (#730): a reader who has read "11 failed" wants those eleven, where they
				 * read the number. Pressing the active one clears it, so the control undoes itself
				 * in the same place.
				 */}
				<span className="flex items-center gap-1.5 sm:ml-auto">
					{STEP_OUTCOMES.map((outcome) => {
						const isActive = outcomeFilter === outcome;
						if (!showsCountChip(outcome, counts[outcome], isActive)) return null;
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
									{formatNumber(counts[outcome])} {outcome}
								</Badge>
							</button>
						);
					})}
				</span>

				{/* Last, and only while the run is live. A terminal run has
				    nothing to stop, and a Stop that lingers on a finished run
				    reads as a run that never ended. */}
				{isLive && <StopRunButton onStop={() => void stop()} isStopping={isStopping} />}
			</header>

			<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
				{streamError && (
					<Callout severity="warning" title="Live updates stopped" className="enter-fade">
						{/* An engine stop's message is the whole story: no run is left to finish. */}
						{streamError}
						{!endedByEngineStop &&
							" The run itself is unaffected - reopen this tab once it finishes to read its stored steps."}
					</Callout>
				)}

				{thinned && (
					<Callout severity="info" title="Bounded step storage" className="enter-fade">
						This run executed {thinned.stepsExecuted.toLocaleString()} steps and kept{" "}
						{thinned.stepsStored.toLocaleString()}. The{" "}
						{thinned.stepsDropped.toLocaleString()} not listed were successes - every
						step that did not pass was kept. Raise <code>maxScenarioStoredSteps</code>{" "}
						in Settings to keep more.
					</Callout>
				)}

				{/*
				 * What the rows below are, before a reader opens them: each holds its request and
				 * response as they went over the wire. The load-mode sibling sits over the Samples
				 * tab; without this one, the Data tab's "rows are never saved anywhere" reads as
				 * covering the cells those rows bound (#731).
				 */}
				<StoredExchangeWarning
					steps={steps.length}
					dataBound={dataBound}
					dataFileName={dataFileName}
				/>

				{/* The run's budgets, first of the whole-run answers: a missed one
				    is what marks the run's row failed in every list, and the row
				    names no budget, so this card is where it is read (#3539).
				    Absent for a run that declared none and for a report still in
				    flight, which holds no verdict. */}
				<ThresholdVerdict
					verdict={report?.thresholdValidation}
					runId={run.id}
					stopped={report ? stoppedRunOf(report) : undefined}
				/>

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

				{/* What script.setup / script.teardown did, once each, at the
				    run's own boundary rather than at any step. Absent for a
				    run whose collection declared neither. */}
				<ScriptLifecycleSummary lifecycle={report?.lifecycle} />

				{/* A folder's members, summed into one latency distribution per
				    pass (issue #1515) - beside the other whole-run answers above
				    the step list, since a transaction spans a folder, not one
				    step. Absent for a collection with no control.transaction
				    element. */}
				<TransactionsSummary transactions={report?.scenario?.transactions} />

				{steps.length === 0 ? (
					/*
					 * Three answers, not two: "still running", "still loading" and "nothing at all"
					 * otherwise read as the same blank list. The stream alone is not enough: a tab
					 * reopened onto a run still executing (after a relaunch, or from History) has
					 * no live steps and no stored ones, and saying it recorded nothing would be
					 * wrong about a run still going.
					 *
					 * `isLoading` is checked second, not folded into the first branch: a live run's
					 * own report fetch is *also* loading before its first refetch, and "waiting for
					 * the first step" is the truer sentence there, as the run has nothing stored
					 * yet either way. A completed run reopened from History has no live signal, so
					 * this branch is the only one that fires for it, with a spinning icon rather
					 * than the static one of every other empty state, so a slow fetch reads as in
					 * progress, not as a run that finished with nothing.
					 */
					isLive ? (
						<EmptyState
							icon={Loader2}
							iconClassName="animate-spin"
							title="Waiting for the first step"
							description="Steps appear here as the run executes them."
						/>
					) : isLoading ? (
						<EmptyState
							icon={Loader2}
							iconClassName="animate-spin"
							title="Loading this run's steps"
							description="Fetching the stored results for this run."
						/>
					) : (
						<EmptyState
							icon={ListOrdered}
							title="No steps recorded"
							description="This run stored no step results."
						/>
					)
				) : emptyReason ? (
					/*
					 * Narrowed to nothing by a control, which is not "no such steps" in either
					 * direction: thinning keeps every non-passing row and drops passes, so a
					 * 6,000-step run can report 5,010 passed and hold none of them (the chip's
					 * number is the run's, this list the store's), and a search matches only the
					 * kept rows' names. Naming the control responsible is the difference between a
					 * disclosure and a contradiction.
					 */
					<EmptyState
						icon={ListOrdered}
						title={emptyReason.title}
						description={emptyReason.description}
					/>
				) : (
					<>
						{/* `divide-y`, not per-step `space-y` - the flat hairline
						    list every other list surface in the app uses
						    (`RunItem`, `RecentRuns`, `SampleRequestCard`), not a
						    boxed card per step. */}
						<div className="divide-y">
							{rendered.map((step) => (
								/*
								 * `skip-offscreen` per card, sized for a flat row rather than a
								 * console line: the browser skips layout and paint for cards
								 * scrolled past, which keeps a filled store's list responsive.
								 */
								<div
									key={stepKey(step)}
									className="skip-offscreen [--skip-offscreen-size:3rem]"
								>
									<ScenarioStepCard
										step={step}
										showIteration={showIteration}
										isExpanded={expanded === stepKey(step)}
										onToggle={toggle}
										runId={run.id}
									/>
								</div>
							))}
						</div>
						{hasMore && (
							/*
							 * The sentinel: reaching it renders the next slice, so nothing is
							 * withheld. The count is stated rather than left to a scrollbar, as the
							 * console's is.
							 */
							<p
								ref={sentinelRef}
								className="px-1 py-2 text-xs text-muted-foreground"
							>
								Showing {rendered.length.toLocaleString()} of{" "}
								{shownSteps.total.toLocaleString()} steps - scroll for more.
							</p>
						)}
					</>
				)}
			</div>
		</div>
	);
}
