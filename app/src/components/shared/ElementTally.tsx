/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One element's tally line (which element, and what happened to it across a load run), shared by
 * the single-request Elements card and the scenario Steps tab (#2144).
 *
 * **A `deferred` element is not a skipped one.** A post-request script does not run inline on the
 * load path; the engine replays it against sampled responses and reports it in the Test validation
 * card (Sampled replay beside an exact Assertions card, #2820), so its `passed`/`failed` are zero
 * by construction and "0 passed" would read as a script doing nothing. `deferred` is absent from a
 * report stored before #2144, which keeps the older rendering.
 *
 * **`missing` and `error` are buckets of their own (#3051)**: an extractor finding nothing is
 * `missing`, not `skipped`, and an element unable to run its check is `error`, not `failed`; the
 * engine's `failed` includes neither. A `required` extractor's miss fails the step, so its bucket
 * takes the error colour and says so. A row stored before #3051 has neither, and its `skipped` and
 * `failed` keep what they counted then. The row names its element (`name`, the kind beside it) and
 * the level it was composed from (`origin`); without a `name` it prints the kind.
 *
 * **An inline script row carries what the script said (#3127)**, drawn under the line by
 * {@link ElementMessages}. The deferred line names the replay's sample size when known, as
 * "deferred" alone hides that the replay judged a few hundred responses, not all.
 */

import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { pluralize } from "@/modules/dashboard/utils/format";
import { ElementMessages } from "./ElementMessages";
import { elementOriginLabel } from "./element-origin";
import { TEST_VALIDATION_TITLE, replayPhrase } from "./run-assertions";
import type { RunScenarioStepElementTally } from "@/types/domain";

/** Why a required extractor's miss reads as a failure; the trace's outcome row says it too. */
export const REQUIRED_MISS_HINT = "A required extractor found nothing, which fails the step.";

export interface ElementTallyProps {
	element: RunScenarioStepElementTally;
	/** The card a deferred row points at; `testValidationTitleOf` names it for a report. */
	replayCard?: string;
	/**
	 * Responses the replay ran over (`testValidation.samplesTested`, or the step's
	 * `tests.sampled`); absent where the report does not say, and the line names the replay without
	 * a size.
	 */
	replaySamples?: number;
	className?: string;
}

export function ElementTally({
	element,
	replayCard = TEST_VALIDATION_TITLE,
	replaySamples,
	className,
}: ElementTallyProps) {
	const deferred = element.deferred ?? 0;
	const missing = element.missing ?? 0;
	const error = element.error ?? 0;
	const origin = elementOriginLabel(element.origin);
	// A deferred row has no inline pass count; every other row states "N passed", zero included.
	const showPassed = deferred === 0 || element.passed > 0;

	return (
		<div className={className}>
			<div className="flex flex-wrap items-center gap-x-2">
				{element.name ? (
					<>
						<span className="font-medium text-foreground">{element.name}</span>
						<span className="text-muted-foreground font-mono">{element.kind}</span>
					</>
				) : (
					<span className="text-muted-foreground font-mono">{element.kind}</span>
				)}
				{origin && <span className="text-muted-foreground">{origin}</span>}
				{deferred > 0 && (
					<span className="font-mono text-muted-foreground">
						{formatNumber(deferred)} {pluralize(deferred, "request")} deferred to a{" "}
						{replayPhrase(replaySamples)} - results in {replayCard}
					</span>
				)}
				{showPassed && (
					<span className="font-mono text-status-success-text">
						{formatNumber(element.passed)} passed
					</span>
				)}
				{element.failed > 0 && (
					<span className="font-mono text-status-error-text">
						{formatNumber(element.failed)} failed
					</span>
				)}
				{missing > 0 && (
					<span
						className={cn(
							"font-mono",
							element.required ? "text-status-error-text" : "text-status-warning-text"
						)}
						title={element.required ? REQUIRED_MISS_HINT : undefined}
					>
						{formatNumber(missing)} missing{element.required ? " (required)" : ""}
					</span>
				)}
				{error > 0 && (
					<span className="font-mono text-status-error-text">
						{formatNumber(error)} error
					</span>
				)}
				{element.skipped > 0 && (
					<span className="font-mono text-muted-foreground">
						{formatNumber(element.skipped)} skipped
					</span>
				)}
			</div>
			<ElementMessages element={element} />
		</div>
	);
}
