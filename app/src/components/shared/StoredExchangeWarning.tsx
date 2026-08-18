/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "The steps below were stored verbatim" - the design-mode counterpart of
 * `CapturedDataWarning` (issue #731).
 *
 * A collection run writes one `results` row per step execution carrying the
 * whole exchange - the composed request, the headers as sent (`sentHeaders`),
 * the raw request line libcurl produced, both bodies - capped only by
 * `maxTraceBodyBytes` and kept until run pruning. That is the same
 * deliberately-unredacted material the load-mode capture notice covers, so the
 * two disclosures are a pair: change one and read the other.
 *
 * The `dataBound` half is what makes this more than symmetry. The Data tab and
 * `docs/app/data-driven-runs.md` promise the *file* is never read by the engine
 * and the *contract* stores no cells, and a reader took that for "no cell of my
 * credentials CSV is ever written down" - which is false of every cell that
 * reached a request, since bind-before-auth (#591) builds the `Authorization`
 * header out of the row before it is encoded. Where rows were bound, the notice
 * says so rather than leaving the reader to reconcile two true-sounding claims.
 *
 * Silent when the surface lists no steps: with nothing on screen there is
 * nothing to disclose, the same absent-vs-zero rule `SampleRetentionNote` and
 * `CapturedDataWarning` follow.
 */

import { Callout } from "./Callout";

export interface StoredExchangeWarningProps {
	/** How many step executions the surface is listing. Silent at zero. */
	steps: number;
	/**
	 * Whether this run bound a data set - any listed step carrying a row index.
	 * Both step sources carry it, so the sentence does not appear only once the
	 * run has finished.
	 */
	dataBound: boolean;
	className?: string;
}

export function StoredExchangeWarning({ steps, dataBound, className }: StoredExchangeWarningProps) {
	if (steps <= 0) return null;

	return (
		<Callout severity="warning" title="Stored step data" className={className}>
			Every step here is stored with its exchange as sent and received - request headers
			included, so a resolved <code>Authorization</code> header, a <code>Cookie</code> line or
			a token in a body is stored with it.
			{dataBound && (
				<>
					{" "}
					This run bound a data file, and a bound value is part of the request that
					carried it: those cells are stored in these steps, though the file itself was
					never read by the engine and the collection&apos;s contract keeps none of them.
				</>
			)}{" "}
			It is deleted when the run is, so the <code>maxRunsRetained</code> setting is its
			expiry.
		</Callout>
	);
}
