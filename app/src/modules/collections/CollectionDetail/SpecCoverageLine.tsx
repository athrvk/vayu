/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Spec tab's answer to "when did we last exercise this contract, and how
 * much of it" (issue #629).
 *
 * The binding page is where a reader asks that question, and until this it
 * could only be answered by finding the run in History and opening its report.
 * One line, and a link to the run that produced it.
 *
 * **It reports the run's own coverage, not a recomputation.** The numbers come
 * off the stored report, which was computed against the document the run was
 * *planned* with - so a collection that has synced since shows what the older
 * run actually covered rather than a figure re-derived against today's
 * contract. That is the same pin the report itself carries, and re-deriving
 * here would be a second, quietly disagreeing answer.
 *
 * Silent in three cases, all of them honest: no run of this collection yet, a
 * last run that was not measured against a contract, and a report that has not
 * loaded. None of them is "0% covered".
 */

import { useLastCollectionRunQuery, useRunReportQuery } from "@/queries/runs";
import { useTabsStore } from "@/stores";
import { formatRelativeTime } from "@/utils";

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
		<p className="mt-1 text-[11px] text-muted-foreground">
			Last run covered {coverage.operationsCovered} of {coverage.operationsTotal} operations
			and {coverage.declaredResponsesHit} of {coverage.declaredResponsesTotal} declared
			responses,{" "}
			<button
				type="button"
				className="underline underline-offset-2 hover:text-foreground"
				onClick={() => openTab({ type: "run", entityId: lastRun.id })}
			>
				{formatRelativeTime(lastRun.startTime)}
			</button>
			.
		</p>
	);
}
