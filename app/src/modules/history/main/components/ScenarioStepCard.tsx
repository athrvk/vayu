/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One step execution of a collection run, expandable into its exchange.
 *
 * The row is the shared `SampledExchange` - the same shell the dashboard's
 * live samples and the history Samples tab render - so a fix to the row, the
 * expansion chrome or the timing tiles reaches the step list too. What this
 * component adds is the two things a step has and a load-run sample does not:
 * a name, and an outcome that is not derivable from the status code.
 *
 * The response comes back through `responseFromRunResult`, the same path a
 * design run's response pane restores from, rather than a second reading of
 * `trace_data` - a copy of that mapping would not receive its fixes
 * (`bodyTruncated`/`bodyBytes`, the `httpVersion` fallback).
 *
 * A row streamed live has no stored result yet and therefore no exchange to
 * show. Inventing a response for it would be a claim the run has not made - so
 * it expands onto the reason instead. An accordion that opens onto nothing at
 * all reads as a bug in the app rather than as a step whose exchange has not
 * been written yet, which is what it is: the engine batches every step row to
 * SQLite when the run ends.
 *
 * ## The way back to the request (issue #730)
 *
 * A step that failed used to be a dead end: the trace named the request it came
 * from and nothing read it, so reproducing "iteration 501 row 501 failed" meant
 * finding the request in the tree by name and then discovering the row was out
 * of the picker's reach. The action beside the summary is that path - it opens
 * the request and hands the builder the row this iteration bound, so the repro
 * is the step's own action and then one click on the row.
 *
 * It is on a live row too (issue #831): the `step` frame names the request, so
 * the reader watching iteration 12 of 500 fail can go straight to it instead of
 * waiting the run out. The expansion below is still the thing that arrives
 * later - a live row has no stored exchange.
 *
 * It is absent, not disabled, on a row that has no `requestId`: a step whose
 * plan entry names no stored request, and a row written before the runner
 * stamped one. A control offering to open a request the row cannot name would
 * be a promise this card cannot keep.
 */

import { memo } from "react";
import { ExternalLink } from "lucide-react";

import { Badge, Button } from "@/components/ui";
import { Callout } from "@/components/shared";
import { useTabsStore } from "@/stores";
import {
	SampledExchange,
	TestsChip,
	UnifiedResponseViewer,
	ValidationChip,
	phasesFromTrace,
	formatSize,
	type ExchangeState,
} from "@/components/shared/response-viewer";
import SchemaValidation from "@/modules/request-builder/components/ResponseViewer/SchemaValidation";
import TestResults from "@/modules/request-builder/components/ResponseViewer/TestResults";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import { cn } from "@/lib/utils";
import type { StepOutcome } from "@/types";
import { tallyTests, type ScenarioStepRow } from "../scenario-steps";

/**
 * How each outcome reads in the row.
 *
 * `skipped` has its own state and its own chip and is never dressed as a pass:
 * a step the runner did not execute asserted nothing. `failed` is a test
 * assertion that did not hold - the response itself may well be a `200`, which
 * is exactly why the state cannot be derived from the status code.
 */
const OUTCOME_STATE: Record<StepOutcome, ExchangeState> = {
	passed: "success",
	failed: "error",
	skipped: "skipped",
	errored: "error",
};

/** Chip tint per outcome. `-fill` under a white label, per the token rules. */
const OUTCOME_CHIP: Record<StepOutcome, string> = {
	passed: "bg-status-success-fill text-white",
	failed: "bg-status-error-fill text-white",
	skipped: "bg-muted text-muted-foreground",
	errored: "bg-status-error-fill text-white",
};

export interface ScenarioStepCardProps {
	step: ScenarioStepRow;
	/** True when the run ran more than one iteration, so the row says which. */
	showIteration: boolean;
	isExpanded: boolean;
	/**
	 * Told which step it was, rather than closing over it at the call site.
	 *
	 * The list holds one handler for all of its rows (issue #1153): a
	 * per-row arrow would be a new prop on every render of the list, and the
	 * memo below would never once hold.
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

	const response = step.result ? responseFromRunResult(step.result, runId) : null;
	const phases = phasesFromTrace(step.result?.trace);

	// The schema verdict from whichever source this row has (issue #681): the
	// live `step` event before the run ends, and the restored response after -
	// through the same funnel the response itself comes from, so nothing here
	// re-reads `trace.validation` and the two cannot drift. They are one object
	// either way: the engine publishes and stores the same node.
	const validation = step.validation ?? response?.validation;

	// The assertions this step made (issue #724). The stored list wins the
	// moment there is one - it is the same assertions the live tally counted,
	// and the row below renders from it - so a step does not change its numbers
	// when its stored row arrives. A live row keeps the frame's tally, which is
	// all a run being watched has.
	const testResults = response?.testResults;
	const tests = tallyTests(testResults) ?? step.tests;

	// The step's own failure text: a test assertion that did not hold, or the
	// error that ended the iteration. A live row has none until its stored row
	// arrives, which is why the shell renders without one rather than blank.
	const error = step.result?.error;

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
	 * The row's own number is carried only when the run bound one, and only when
	 * it is a row. A step of a collection with no data set has nothing to select
	 * - pointing the picker at row 0 there would select a row out of a file the
	 * run never read - and a stored index that is not a whole row is a malformed
	 * trace, which `openRequestWithDataRow` refuses outright. The link stays,
	 * without the row: the request is still where the reader was going.
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
					<Badge variant="chip" className={cn("shrink-0", OUTCOME_CHIP[step.outcome])}>
						{step.outcome}
					</Badge>
					{/*
					 * Beside the outcome and not folded into it: with
					 * `failOnSchemaError` off - the default - a step can pass
					 * every assertion while its response does not match what the
					 * document declares, and those are two separate facts. The
					 * shared chip, so the three-state wording is the one the
					 * response pane already uses.
					 */}
					{validation && <ValidationChip validation={validation} className="shrink-0" />}
					{/*
					 * Beside the verdict and not folded into the outcome either:
					 * a step is `failed` whether one assertion did not hold or
					 * twelve did not, and the row is where that difference is
					 * cheap to show. Present live, from the frame's tally, so a
					 * run being watched says more than "failed".
					 */}
					{tests && <TestsChip tests={tests} className="shrink-0" />}
				</span>
			}
			actions={
				requestId ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-8 gap-1.5 px-2 text-xs"
						onClick={() => openRequest(requestId)}
						aria-label={
							rowIndex === undefined
								? `Open the request ${step.name} ran`
								: `Open the request ${step.name} ran, with row ${rowIndex + 1} selected`
						}
					>
						<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
						{/* The row number is the information, so it is on the
						    control rather than only in its name - this is the row
						    the repro has to bind, and the picker it opens is where
						    finding it by hand was the dead end. */}
						{rowIndex === undefined ? "Open request" : `Repro row ${rowIndex + 1}`}
					</Button>
				) : undefined
			}
			state={OUTCOME_STATE[step.outcome]}
			statusCode={step.statusCode}
			statusText={step.result?.statusText}
			latencyMs={step.latencyMs}
			timestamp={context}
			error={error}
			phases={phases}
			isExpanded={isExpanded}
			onToggle={() => onToggle(step)}
			className={cn(
				"border border-rule",
				step.outcome === "failed" || step.outcome === "errored"
					? "border-destructive/30"
					: step.outcome === "passed" && "border-status-success/20"
			)}
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
			 * The verdict in full, inside the expansion. The same section the
			 * response pane's Tests tab renders, rather than a second layout of
			 * one verdict - the failure list and the unevaluated-keyword
			 * disclosure are the parts that make the chip above honest, and a
			 * copy of them here would not receive that section's fixes.
			 */}
			{validation && <SchemaValidation validation={validation} />}

			{/*
			 * Every assertion the step's scripts made (issue #724), from the
			 * stored trace - both phases, grouped by script (issue #810). The
			 * same component the response pane's Tests tab
			 * renders, stacked under the schema verdict the way that tab stacks
			 * them - `inset={false}` because this expansion owns the padding,
			 * exactly as the tab does for the pair.
			 *
			 * A live row has none: the list rides the stored trace, so what the
			 * chip above shows from the frame's tally is all there is until the
			 * run ends and the row is written.
			 */}
			{testResults && testResults.length > 0 && (
				<TestResults results={testResults} inset={false} />
			)}

			{response && (
				<div className="space-y-2">
					{/* The engine caps a stored trace body at `maxTraceBodyBytes`,
					    so what is below can be a slice. Saying so is what keeps a
					    clipped body from reading as the whole response - the same
					    notice the builder's response pane shows for the same
					    reason. */}
					{response.bodyTruncated && (
						<Callout severity="warning" title="Body truncated for storage">
							Only the first {formatSize(response.body.length)} of{" "}
							{formatSize(response.bodyBytes ?? response.body.length)} was kept.
						</Callout>
					)}
					<UnifiedResponseViewer
						response={{
							body: response.body,
							bodyRaw: response.bodyRaw,
							headers: response.headers,
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
 * Memoized, because a live run re-renders the list around it (issue #1153).
 *
 * Up to 200 of these are mounted at once and a run streaming its steps
 * re-renders the list several times a second, where all but the newest cards
 * are rendering exactly what they rendered before. Every prop holds its
 * identity across such a render: `step` rows are replaced only by an event for
 * that same step, `onToggle` is one handler for the whole list, and the rest
 * are primitives. The default shallow comparison is therefore the whole
 * requirement - a custom comparator here would be a second copy of that fact,
 * free to disagree with it.
 */
export default memo(ScenarioStepCard);
