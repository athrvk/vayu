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

	return (
		<Callout severity="info" title="Bounded retention" className={className}>
			{displaced.toLocaleString()} further {noun} were displaced by this run&apos;s retention
			limit. The {shown.toLocaleString()} {verb} are drawn uniformly from the whole run, not
			from its opening.
		</Callout>
	);
}
