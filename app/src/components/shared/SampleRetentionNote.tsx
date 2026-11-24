/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a run's bounded stores thinned away, wherever a sampled set shows: otherwise a list of 100
 * samples reads as "100 requests worth showing" when it can be 100 of 30,000. The dashboard's
 * Sampled Requests, the history Samples tab and the tested responses share it, so the sentence
 * lives once. Silent with nothing to say (nothing dropped, or a summary predating the counts):
 * "nothing was displaced" and "we cannot tell" are worse as prose than absence. What it says
 * depends on the list: the traces behind `results` are a failures-first selection (#2210), never
 * called uniform; the tested responses are a uniform sample when the count cap displaced an
 * incumbent, and the part whose bodies fit when a spent byte budget stopped admitting,
 * `sampling.responseSampleBudgetSpent` saying which (#1192).
 */

import { formatNumber } from "@/lib/format-number";
import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

export interface SampleRetentionNoteProps {
	sampling: RunReport["sampling"];
	/** How many records this surface is showing. */
	shown: number;
	/**
	 * The budget the surface draws from: `traces` is the sampled and slow-request stores behind
	 * `results`, `responses` the buffer post-run test scripts are evaluated against.
	 */
	budget: "traces" | "responses";
	className?: string;
}

export function SampleRetentionNote({
	sampling,
	shown,
	budget,
	className,
}: SampleRetentionNoteProps) {
	if (!sampling) return null;

	// The two trace stores are one story to a reader of one list: both feed `results`, and which
	// budget a row was charged to is an engine detail.
	const displaced =
		budget === "traces"
			? sampling.successTracesDropped + sampling.slowTracesDropped
			: sampling.responseSamplesDropped;

	if (displaced <= 0) return null;

	const noun = budget === "traces" ? "samples" : "responses";

	return (
		<Callout severity="info" title="Bounded retention" className={className}>
			{formatNumber(displaced)} further {noun} were displaced by this run&apos;s retention
			limit. {describeShownSet(budget, sampling, shown)}
		</Callout>
	);
}

// The response store's byte budget stops admitting rather than displacing, so a run that spent it
// was graded on the part whose bodies fit. An `undefined` marker (a run recorded before the engine
// said which bound applied) keeps the uniformity sentence: weakening every older run's claim would
// cost the accurate message where it is nearly always right (only a target whose kept bodies
// average over ~256 KiB reaches the budget at the defaults).
function describeShownSet(
	budget: SampleRetentionNoteProps["budget"],
	sampling: NonNullable<RunReport["sampling"]>,
	shown: number
): string {
	const count = formatNumber(shown);
	// `results` is chosen by the report route, not drawn from the reservoir: rows with an error
	// take the slots first.
	if (budget === "traces") {
		return `Requests with an error are kept ahead of successful ones in the ${count} shown, so they are not a uniform sample of the run.`;
	}
	if (sampling.responseSampleBudgetSpent === true) {
		return `Its response-sample budget was spent, so the ${count} tested are drawn from the part of the run whose bodies fit, not uniformly from the whole of it.`;
	}
	return `The ${count} tested are drawn uniformly from the whole run, not from its opening.`;
}
