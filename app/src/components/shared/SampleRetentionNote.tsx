/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Says what a run's bounded stores thinned away, wherever a sampled set is on
 * screen.
 *
 * Without it a list of 100 samples reads as "this run made 100 requests worth
 * showing", when it can be 100 kept out of 30,000 candidates. Two surfaces show
 * such a list - the dashboard's Sampled Requests and the history Samples tab -
 * and a third shows the tested responses, so the sentence lives here once
 * rather than being written out three times and drifting.
 *
 * Silent unless there is something to say: a run that dropped nothing, or one
 * whose summary predates the counts, gets no notice at all. "Nothing was
 * displaced" and "we cannot tell" are both worse as prose than as absence.
 *
 * What it says about the tested responses depends on which bound thinned them:
 * the count cap displaces an incumbent and leaves a uniform sample of the run,
 * while a spent byte budget stops admitting and leaves the part of it whose
 * bodies fit. `sampling.responseSampleBudgetSpent` is the engine's answer to
 * which one happened (issue #1192).
 */

import { Callout } from "./Callout";
import type { RunReport } from "@/types/domain";

export interface SampleRetentionNoteProps {
	sampling: RunReport["sampling"];
	/** How many records this surface is showing. */
	shown: number;
	/**
	 * Which budget the surface draws from. `traces` covers the sampled and
	 * slow-request stores behind `results`; `responses` covers the buffer that
	 * post-run test scripts are evaluated against.
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

	// The two trace stores are one story to a reader looking at one list: both
	// feed `results`, and which budget a given row was charged to is an engine
	// detail, not something to make the reader reconcile.
	const displaced =
		budget === "traces"
			? sampling.successTracesDropped + sampling.slowTracesDropped
			: sampling.responseSamplesDropped;

	if (displaced <= 0) return null;

	const noun = budget === "traces" ? "samples" : "responses";
	const verb = budget === "traces" ? "shown" : "tested";

	// The uniformity the reservoir buys holds for every bound but one: the
	// response store's byte budget stops admitting rather than displacing, so a
	// run that spent it was graded on the part of it whose bodies fit. An
	// `undefined` marker is a run recorded before the engine reported which
	// bound applied - it keeps today's sentence, because weakening the claim for
	// every older run costs the accurate message in the case that is nearly all
	// of them (only a target whose retained bodies average more than ~256 KiB
	// can reach the budget at the defaults).
	const budgetSpent = budget === "responses" && sampling.responseSampleBudgetSpent === true;

	return (
		<Callout severity="info" title="Bounded retention" className={className}>
			{displaced.toLocaleString()} further {noun} were displaced by this run&apos;s retention
			limit.{" "}
			{budgetSpent
				? `Its response-sample budget was spent, so the ${shown.toLocaleString()} tested are drawn from the part of the run whose bodies fit, not uniformly from the whole of it.`
				: `The ${shown.toLocaleString()} ${verb} are drawn uniformly from the whole run, not from its opening.`}
		</Callout>
	);
}
