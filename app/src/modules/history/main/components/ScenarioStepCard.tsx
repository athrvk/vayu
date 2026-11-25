/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One step execution of a collection run, expandable into its exchange.
 *
 * The row is the shared `SampledExchange`, the shell the dashboard's live samples and the history
 * Samples tab render, so a fix to the row, the expansion chrome or the timing tiles reaches the
 * step list too. This component adds the two things a step has and a load-run sample lacks: a name,
 * and an outcome not derivable from the status code.
 *
 * The response comes back through `responseFromRunResult`, the path a design run's response pane
 * restores from, not a second reading of `trace_data`: a copy of that mapping would miss its fixes
 * (`bodyTruncated`/`bodyBytes`, the `httpVersion` fallback).
 *
 * A row streamed live has no stored result and so no exchange; inventing a response would be a
 * claim the run has not made, so it expands onto the reason. An accordion opening onto nothing
 * reads as an app bug rather than a step whose exchange is not written yet, which it is: the engine
 * batches every step row to SQLite when the run ends.
 *
 * ## The way back to the request (#730)
 *
 * The trace names the request a step came from. The action beside the summary opens that request
 * and hands the builder the row this iteration bound, so reproducing "iteration 501 row 501 failed"
 * is the step's own action and one click on the row, not a search of the tree by name and a picker
 * that cannot reach the row.
 *
 * It is on a live row too (#831): the `step` frame names the request, so a reader watching
 * iteration 12 of 500 fail can go straight to it rather than wait the run out. The expansion is
 * still what arrives later, as a live row has no stored exchange.
 *
 * Absent, not disabled, on a row with no `requestId` (a step whose plan entry names no stored
 * request, or a row written before the runner stamped one): a control offering a request the row
 * cannot name is a promise this card cannot keep.
 */

import { memo, useMemo } from "react";
import { ExternalLink } from "lucide-react";

import { Badge, Button } from "@/components/ui";
import {
	Callout,
	ExchangeWarnings,
	ExtractorMisses,
	SentBodyFileNote,
	UnresolvedTokens,
} from "@/components/shared";
import { formatBytes } from "@/lib/format-number";
import { sentBodyFileOf } from "@/lib/sent-body-file";
import { useTabsStore } from "@/stores";
import {
	HttpVersionDowngradeNote,
	SampledExchange,
	TestsChip,
	UnifiedResponseViewer,
	ValidationChip,
	phasesFromTrace,
} from "@/components/shared/response-viewer";
import ConsoleOutput from "@/modules/request-builder/components/ResponseViewer/ConsoleOutput";
import ElementOutcomes from "@/modules/request-builder/components/ResponseViewer/ElementOutcomes";
import SchemaValidation from "@/modules/request-builder/components/ResponseViewer/SchemaValidation";
import TestResults from "@/modules/request-builder/components/ResponseViewer/TestResults";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import { heldBodySize } from "@/modules/request-builder/utils/response-bytes";
import { cn } from "@/lib/utils";
import { stepsNotRunText, tallyTests, type ScenarioStepRow } from "../scenario-steps";
import { STEP_OUTCOME_CHIP, STEP_OUTCOME_STATE, stepWasAnswered } from "../step-outcome";

export interface ScenarioStepCardProps {
	step: ScenarioStepRow;
	/** True when the run ran more than one iteration, so the row says which. */
	showIteration: boolean;
	isExpanded: boolean;
	/**
	 * Told which step it was rather than closing over it at the call site: the list holds one
	 * handler for all its rows (#1153), as a per-row arrow would be a new prop every render and the
	 * memo below would never hold.
	 */
	onToggle: (step: ScenarioStepRow) => void;
	runId: string;
}

function ScenarioStepCard({
	step,
	showIteration,
	isExpanded,
	onToggle,
	runId,
}: ScenarioStepCardProps) {
	const openTab = useTabsStore((s) => s.openTab);
	const openRequestWithDataRow = useTabsStore((s) => s.openRequestWithDataRow);

	// Memoized because a base64 body decodes to fresh bytes on every call, and
	// an image preview keyed on them would make a new object URL per render.
	const response = useMemo(
		() => (step.result ? responseFromRunResult(step.result, runId) : null),
		[step.result, runId]
	);
	// A binary body's file, from the step's stored request node.
	const sentFile = sentBodyFileOf(step.result?.trace?.request?.bodyFile);
	const phases = phasesFromTrace(step.result?.trace);

	// The schema verdict from whichever source this row has (#681): the live `step` event before
	// the run ends, the restored response after, through the funnel the response comes from, so
	// nothing here re-reads `trace.validation`. They are one object either way: the engine
	// publishes and stores the same node.
	const validation = step.validation ?? response?.validation;

	// The assertions this step made (#724). The stored list wins once there is one (the same
	// assertions the live tally counted, and what the row below renders), so a step's numbers do
	// not change when its stored row arrives; a live row keeps the frame's tally, all a watched run
	// has.
	const testResults = response?.testResults;
	const tests = tallyTests(testResults) ?? step.tests;

	// What the step's scripts printed and the errors that stopped them, from the
	// same restored response. Absent on a live row, like the list above.
	const consoleLogs = response?.consoleLogs ?? [];
	// The scripts' `pm.sendRequest` records (#3633) are console rows too, and
	// with the console off they are the only ones.
	const scriptRequests = response?.scriptRequests;
	const preScriptError = response?.preScriptError;
	const postScriptError = response?.postScriptError;
	const hasConsole =
		consoleLogs.length > 0 || !!scriptRequests?.length || !!preScriptError || !!postScriptError;

	// The step's own failure text: a test assertion that did not hold, or the
	// error that stopped the step. A live row has none until its stored row
	// arrives, which is why the shell renders without one rather than blank.
	// A stopped step's stored error is the cancel ("Request cancelled"), which
	// the Stopped chip already says and a red Error block would contradict.
	const error = step.outcome === "stopped" ? undefined : step.result?.error;
	const answered = stepWasAnswered(step.outcome);
	const notRun = stepsNotRunText(step.stepsNotRun);

	// "Iteration 2 · Row 3". The row is shown whenever the run had a data set,
	// including a single-iteration one, because it is the only place the step
	// says which row produced it - and with `iterations` above the row count
	// the two numbers deliberately disagree.
	const context = [
		showIteration ? `Iteration ${step.iteration + 1}` : "",
		step.dataRowIndex === undefined ? "" : `Row ${step.dataRowIndex + 1}`,
	]
		.filter(Boolean)
		.join(" · ");

	/*
	 * The row's number is carried only when the run bound one, and only when it is a whole row. A
	 * step of a collection with no data set has nothing to select (row 0 would be a row of a file
	 * the run never read), and a non-integer stored index is a malformed trace, which
	 * `openRequestWithDataRow` refuses. The link stays without the row: the request is still where
	 * the reader was going.
	 */
	const requestId = step.requestId;
	const rowIndex =
		typeof step.dataRowIndex === "number" &&
		Number.isInteger(step.dataRowIndex) &&
		step.dataRowIndex >= 0
			? step.dataRowIndex
			: undefined;
	const openRequest = (id: string) => {
		if (rowIndex === undefined) openTab({ type: "request", entityId: id });
		else openRequestWithDataRow(id, rowIndex);
	};

	return (
		<SampledExchange
			label={step.stepIndex + 1}
			title={
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm text-foreground">{step.name}</span>
					<Badge
						variant="chip"
						className={cn("shrink-0", STEP_OUTCOME_CHIP[step.outcome])}
					>
						{step.outcome}
					</Badge>
					{/*
					 * Beside the outcome, not folded into it: with `failOnSchemaError` off (the
					 * default) a step can pass every assertion while its response does not match
					 * the document, two separate facts. The shared chip, so the three-state wording
					 * is the response pane's.
					 */}
					{validation && <ValidationChip validation={validation} className="shrink-0" />}
					{/*
					 * Beside the verdict and not folded into the outcome: a step is `failed`
					 * whether one assertion or twelve did not hold, and the row is where that
					 * difference is cheap to show. Present live, from the frame's tally, so a
					 * watched run says more than "failed".
					 */}
					{tests && <TestsChip tests={tests} className="shrink-0" />}
					{/*
					 * In the row, live and stored alike (issue #3053): the step
					 * can pass while its extractor found nothing, and the next
					 * step then sends that name unresolved.
					 */}
					<ExtractorMisses count={step.extractorMisses} className="shrink-0" />
					{/* The other half of a miss (issue #3269): the names this step
					    sent as literal `{{text}}`. Distinct names, not sends. */}
					<UnresolvedTokens
						count={step.unresolvedTokens}
						unit="names"
						className="shrink-0"
					/>
				</span>
			}
			actions={
				requestId ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-control-sm gap-1.5 px-2 text-xs"
						onClick={() => openRequest(requestId)}
						aria-label={
							rowIndex === undefined
								? `Open the request ${step.name} ran`
								: `Open the request ${step.name} ran, with row ${rowIndex + 1} selected`
						}
					>
						<ExternalLink aria-hidden="true" className="size-icon-sm" />
						{/* The row number is the information, so it is on the
						    control rather than only in its name - this is the row
						    the repro has to bind, and the picker it opens is where
						    finding it by hand was the dead end. */}
						{rowIndex === undefined ? "Open request" : `Repro row ${rowIndex + 1}`}
					</Button>
				) : undefined
			}
			state={STEP_OUTCOME_STATE[step.outcome]}
			statusCode={answered ? step.statusCode : undefined}
			statusText={step.result?.statusText}
			latencyMs={answered ? step.latencyMs : undefined}
			timestamp={context}
			error={error}
			details={
				notRun && (
					// On the step that ended its iteration (issue #2526), live and
					// stored alike: the error above is one thing and what it cost
					// the iteration is another.
					<p className="text-xs text-muted-foreground">Ended this iteration: {notRun}</p>
				)
			}
			phases={phases}
			scriptMs={step.result?.trace?.scriptMs}
			isExpanded={isExpanded}
			onToggle={() => onToggle(step)}
			// No per-row border: `ScenarioRunView` wraps the list in a `divide-y`, matching
			// `SampleRequestCard`'s flat hairline row. Unlike that sibling, no
			// `border-b last:border-b-0` either: each step sits in its own `skip-offscreen`
			// wrapper, so this row is always that div's sole (so "last") child, and the border
			// between steps has to come from the shared parent, where `:last-child` is the actual
			// last step. Status rides the icon tint alone, as in `SampleRequestCard`.
		>
			{!response && (
				<p className="text-xs text-muted-foreground">
					{step.result
						? // A stored row whose trace carried neither a response nor an
							// error - `responseFromRunResult` returns null for it rather
							// than a hollow 0-byte response.
							"This step recorded no exchange."
						: "The request and response appear here once the run finishes - steps are stored when it ends."}
				</p>
			)}

			{/*
			 * The verdict in full, inside the expansion: the response pane's Tests-tab section, not
			 * a second layout. Its failure list and unevaluated-keyword disclosure are what make
			 * the chip above honest, and a copy would miss that section's fixes.
			 */}
			{validation && <SchemaValidation validation={validation} />}

			{/*
			 * Every assertion the step's scripts made (#724), from the stored trace, both phases,
			 * grouped by script (#810): the response pane's Tests-tab component, stacked under the
			 * schema verdict as that tab stacks them, `inset={false}` because this expansion owns
			 * the padding, as the tab does. A live row has none: the list rides the stored trace,
			 * so the chip's frame tally is all there is until the row is written.
			 */}
			{testResults && testResults.length > 0 && (
				<TestResults results={testResults} inset={false} />
			)}

			{/*
			 * The step's typed elements (#1512): extractors, assertions and timers, beside the
			 * script results above, from the same stored trace, so a live row shows none until the
			 * row is written.
			 */}
			{response?.elements && response.elements.length > 0 && (
				<ElementOutcomes outcomes={response.elements} inset={false} />
			)}

			{/*
			 * The step's console lines and script errors (#3126), under the Tests they belong with:
			 * the response pane's own `ConsoleOutput`, so the level labels, the filter and the
			 * progressive window are one implementation. It fills a parent of definite height in
			 * the Console tab; the expansion has none, so the box is bounded to the response
			 * viewer's 400px and scrolls. Rendered only with something to show, so a scriptless
			 * step gains no "No console output" block.
			 */}
			{hasConsole && (
				<div className="max-h-[400px] overflow-auto">
					<ConsoleOutput
						logs={consoleLogs}
						scriptRequests={scriptRequests}
						errors={{ pre: preScriptError, post: postScriptError }}
					/>
				</div>
			)}

			{sentFile && <SentBodyFileNote file={sentFile} />}

			{response && (
				<div className="space-y-2">
					{/* The engine caps a stored trace body at `maxTraceBodyBytes`,
					    so what is below can be a slice. Saying so is what keeps a
					    clipped body from reading as the whole response - the same
					    notice the builder's response pane shows for the same
					    reason. */}
					{response.bodyTruncated && (
						<Callout severity="warning" title="Body truncated for storage">
							Only the first {formatBytes(heldBodySize(response))} of{" "}
							{formatBytes(response.bodyBytes ?? heldBodySize(response))} was kept.
						</Callout>
					)}
					{/* The viewer below has no status bar to carry it (#3262). */}
					{response.httpVersionDowngraded && (
						<HttpVersionDowngradeNote httpVersion={response.httpVersion} />
					)}
					<ExchangeWarnings warnings={response.warnings} />
					<UnifiedResponseViewer
						response={{
							body: response.body,
							bodyRaw: response.bodyRaw,
							rawBytes: response.rawBytes,
							headers: response.headers,
							headerLines: response.headerLines,
							status: response.status,
							statusText: response.statusText,
						}}
						request={{ headers: response.requestHeaders }}
						className="max-h-[400px]"
					/>
				</div>
			)}
		</SampledExchange>
	);
}

/**
 * Memoized, as a live run re-renders the list around it (#1153): up to 200 cards are mounted and a
 * streaming run re-renders the list several times a second, all but the newest card rendering what
 * it did before. Every prop keeps its identity across such a render (`step` rows are replaced only
 * by an event for that step, `onToggle` is one handler for the list, the rest are primitives), so
 * the default shallow comparison is the whole requirement; a custom comparator would be a second
 * copy of that fact, free to disagree.
 */
export default memo(ScenarioStepCard);
