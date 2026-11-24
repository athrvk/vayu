/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "The steps below were stored verbatim", the design-mode counterpart of `CapturedDataWarning`
 * (#731). A collection run writes one `results` row per step execution with the whole exchange (the
 * composed request, the headers as sent, libcurl's raw request line, both bodies), capped only by
 * `maxTraceBodyBytes` and kept until pruning: the same deliberately unredacted material the
 * load-mode capture notice covers, so the two are a pair: change one, read the other. The
 * `dataBound` half matters most: the Data tab and `docs/app/data-driven-runs.md` promise the engine
 * never reads the *file* and the *contract* stores no cells, which a reader took as "no cell of my
 * credentials CSV is written down", false for every cell reaching a request, as bind-before-auth
 * (#591) builds `Authorization` from the row. Where rows were bound, the notice says so. Silent
 * with no steps listed, the absent-vs-zero rule `SampleRetentionNote` and `CapturedDataWarning`
 * follow.
 */

import { Callout } from "./Callout";

export interface StoredExchangeWarningProps {
	/** How many step executions the surface is listing. Silent at zero. */
	steps: number;
	/**
	 * Whether this run bound a data set (a listed step carrying a row index); both step sources
	 * carry it, so the sentence does not wait for the run to finish.
	 */
	dataBound: boolean;
	/**
	 * The bound file's display name (#2051), named in the sentence when the snapshot recorded one;
	 * absent for older runs, which keep the unnamed sentence.
	 */
	dataFileName?: string;
	className?: string;
}

export function StoredExchangeWarning({
	steps,
	dataBound,
	dataFileName,
	className,
}: StoredExchangeWarningProps) {
	if (steps <= 0) return null;

	return (
		<Callout severity="warning" title="Stored step data" className={className}>
			Every step here is stored with its exchange as sent and received - request headers
			included, so a resolved <code>Authorization</code> header, a <code>Cookie</code> line or
			a token in a body is stored with it.
			{dataBound && (
				<>
					{" "}
					This run bound a data file
					{dataFileName && (
						<>
							{" "}
							(<code>{dataFileName}</code>)
						</>
					)}
					, and a bound value is part of the request that carried it: those cells are
					stored in these steps, though the file itself was never read by Vayu&apos;s
					engine and the collection&apos;s contract keeps none of them.
				</>
			)}{" "}
			It is deleted when the run is, so the <code>maxRunsRetained</code> setting is its
			expiry.
		</Callout>
	);
}
