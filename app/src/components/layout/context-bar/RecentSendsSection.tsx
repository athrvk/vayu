/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The last few sends of this request: status, latency and age, newest first.
 *
 * **More than one send is the whole point.** The response pane already says
 * everything there is to say about the *latest* one - `ResponseStatusBar`
 * paints the same status chip, the same duration and the same age, from the
 * same stored run - so a section restating it would be a poorer copy a few
 * hundred pixels to its left, which is why the "last result" section specced in
 * #344 was built and then removed. What the pane structurally cannot show is a
 * sequence: whether that 500 is the first one, whether latency has been
 * drifting, when this last worked. That costs a trip to the History drawer and
 * a tab switch away from the request being debugged, and this is that trip.
 *
 * One list call, no report fetch. Each row's status code and latency ride on
 * the run's own list row (`resultSummary`, added to the paginated `GET /runs`
 * for this); reading them through `GET /runs/:id/report` instead would load and
 * JSON-parse every result's trace, per row, on every expansion.
 *
 * Rows open the run rather than just reporting it - a trend is where you notice
 * the one send worth looking at, and the History tab is where you look at it.
 */

import { useRecentDesignRunsQuery } from "@/queries";
import { useTabsStore } from "@/stores";
import { StatusCodeBadge, formatResponseTime } from "@/components/shared";
import { formatRelativeTime } from "@/utils";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";
import type { Run } from "@/types";

/**
 * What a row says when the run carries no outcome: it is still in flight, or
 * its result never made it to disk. Never a zero status - the wire uses that
 * for a request that reached no server, and inventing it here would report a
 * send that has not happened yet as one that failed.
 */
function pendingLabel(status: Run["status"]): string {
	switch (status) {
		case "pending":
		case "running":
			return "Sending…";
		case "stopped":
			return "Stopped";
		default:
			return "No result";
	}
}

export function RecentSendsSection({ tab }: ContextBarSectionProps) {
	const { data, isLoading } = useRecentDesignRunsQuery(tab.entityId);
	const openTab = useTabsStore((s) => s.openTab);

	if (isLoading && !data) return <SectionLoading />;

	const runs = data?.data ?? [];
	// `useRecentSendsRelevance` reduces this section to a dimmed header before the
	// bar mounts it, so this body is what a caller that mounts the section
	// directly sees, and the honest answer in the render where the last run goes.
	if (runs.length === 0) {
		return <SectionEmpty>This request has not been sent yet</SectionEmpty>;
	}

	return (
		<ul className="space-y-0.5 m-0 p-0 list-none">
			{runs.map((run) => {
				const outcome = run.resultSummary;
				return (
					<li key={run.id}>
						<button
							type="button"
							onClick={() => openTab({ type: "run", entityId: run.id })}
							aria-label={`Open send${
								outcome ? `, status ${outcome.statusCode}` : ""
							}, ${formatRelativeTime(run.startTime)}`}
							className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{outcome ? (
								// The code alone, without the reason phrase: five
								// rows read as a column of codes, and the phrase
								// would push the latency off every one of them.
								<StatusCodeBadge status={outcome.statusCode} />
							) : (
								<span className="text-xs text-muted-foreground shrink-0">
									{pendingLabel(run.status)}
								</span>
							)}
							<span className="flex-1 text-xs font-mono tabular-nums text-foreground truncate">
								{outcome ? formatResponseTime(outcome.latencyMs) : ""}
							</span>
							<span className="text-[11px] font-mono tabular-nums text-muted-foreground shrink-0">
								{formatRelativeTime(run.startTime)}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
