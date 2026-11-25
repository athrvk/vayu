/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Spec tab's answer to "when did we last exercise this contract, and how much of it" (issue
 * #629): one line, and a link to the run that produced it, on the binding page where a reader asks.
 *
 * **It reports the run's own coverage, not a recomputation.** The numbers come off the stored
 * report, computed against the document the run was *planned* with, so a collection synced since
 * shows what the older run covered rather than a figure re-derived against today's contract. That
 * is the report's own pin, and re-deriving here would be a second, quietly disagreeing answer.
 *
 * Silent in three honest cases, none of them "0% covered": no run of this collection yet, a last
 * run not measured against a contract, and a report that has not loaded.
 */

import { useLastCollectionRunQuery, useRunReportQuery } from "@/queries/runs";
import { useTabsStore } from "@/stores";
import { TimeValue } from "@/components/shared/TimeValue";
import { formatInstant } from "@/lib/time-value";

interface SpecCoverageLineProps {
	collectionId: string;
}

export default function SpecCoverageLine({ collectionId }: SpecCoverageLineProps) {
	// The same opener the context bar's Last run section uses, rather than a
	// callback threaded down from the tab: two ways to open one run would be two
	// chances to open it differently.
	const openTab = useTabsStore((s) => s.openTab);
	const { data: runs } = useLastCollectionRunQuery(collectionId);
	const lastRun = runs?.data?.[0];
	// The report is fetched only once there is a run to fetch one for, so a
	// collection that has never been run costs no request at all.
	const { data: report } = useRunReportQuery(lastRun?.id ?? null);
	const coverage = report?.coverage;

	if (!lastRun || !coverage) return null;

	return (
		<p className="mt-1 text-label text-muted-foreground">
			Last run covered {coverage.operationsCovered} of {coverage.operationsTotal} operations
			and {coverage.declaredResponsesHit} of {coverage.declaredResponsesTotal} declared
			responses,{" "}
			<button
				type="button"
				className="underline underline-offset-2 hover:text-foreground"
				aria-label={`Open the last run, ${formatInstant(lastRun.startTime, "relative")}`}
				onClick={() => openTab({ type: "run", entityId: lastRun.id })}
			>
				<TimeValue value={lastRun.startTime} style="relative" />
			</button>
			.
		</p>
	);
}
