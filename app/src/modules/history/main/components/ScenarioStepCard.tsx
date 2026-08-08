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
 */

import { Badge } from "@/components/ui";
import { Callout } from "@/components/shared";
import {
	SampledExchange,
	UnifiedResponseViewer,
	phasesFromTrace,
	formatSize,
	type ExchangeState,
} from "@/components/shared/response-viewer";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import { cn } from "@/lib/utils";
import type { StepOutcome } from "@/types";
import type { ScenarioStepRow } from "../scenario-steps";

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
	onToggle: () => void;
	runId: string;
}

export default function ScenarioStepCard({
	step,
	showIteration,
	isExpanded,
	onToggle,
	runId,
}: ScenarioStepCardProps) {
	const response = step.result ? responseFromRunResult(step.result, runId) : null;
	const phases = phasesFromTrace(step.result?.trace);

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

	return (
		<SampledExchange
			label={step.stepIndex + 1}
			title={
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm text-foreground">{step.name}</span>
					<Badge variant="chip" className={cn("shrink-0", OUTCOME_CHIP[step.outcome])}>
						{step.outcome}
					</Badge>
				</span>
			}
			state={OUTCOME_STATE[step.outcome]}
			statusCode={step.statusCode}
			statusText={step.result?.statusText}
			latencyMs={step.latencyMs}
			timestamp={context}
			error={error}
			phases={phases}
			isExpanded={isExpanded}
			onToggle={onToggle}
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
