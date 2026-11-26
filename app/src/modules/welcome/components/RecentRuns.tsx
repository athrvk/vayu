/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Flat rows, not cards (a card grid reads as a landing page), in the app's run vocabulary (method
 * badge, type badge, status tokens, mono timestamps) so it matches the dashboard and history views.
 *
 * Each row leads with what was run, or the list reads "Load · Completed · 2 hours ago" five times
 * with nothing telling the rows apart: the method and URL from the run `summary`, as the history
 * sidebar shows. Not the request's *name*: a run stores none, and `requestId` is set only for
 * design runs, so most rows (every load test) would have nothing to look up. The snapshot's URL is
 * always there and is what was actually sent, even if the request was since renamed, edited or
 * deleted.
 *
 * A run whose work is a collection has no URL or method; its row names the collection, resolved
 * from `summary.scenario.collectionId` as the history sidebar does (#3496).
 */

import { ChevronRight } from "lucide-react";
import { useTabsStore } from "@/stores";
import {
	MethodBadge,
	TruncatedText,
	rowOutcome,
	verdictBesideStatus,
	runStatusDisplay,
} from "@/components/shared";
import { Button, Eyebrow } from "@/components/ui";
import { TimeValue } from "@/components/shared/TimeValue";
import { useCollectionsQuery } from "@/queries";
import type { Collection, Run } from "@/types";
import { RUN_TYPE_NAME } from "@/modules/history/types";

const RECENT_RUN_LIMIT = 5;

/**
 * Only a terminal status is called out here: the welcome screen lists what
 * happened, not what is in flight, so `running` and `pending` get no label.
 */
const SETTLED_STATUSES: ReadonlySet<Run["status"]> = new Set(["completed", "stopped", "failed"]);

interface StatusLabel {
	text: string;
	className: string;
	/** The verdict's word when it adds to the status word, for the row's accessible name. */
	verdict: string | null;
}

/**
 * The word and `--status-*-text` token come from `runStatusDisplay`, fed the run's verdict as the
 * history sidebar's `RunItem` feeds it: two lists of the same runs answering in two colours is the
 * drift it prevents (#1225), and a collection run with failed steps reading green is that drift
 * again (#3496).
 */
function statusLabel(run: Run): StatusLabel | null {
	if (!SETTLED_STATUSES.has(run.status)) return null;
	const judgement = rowOutcome(run);
	const { label, text } = runStatusDisplay(run.status, judgement?.outcome);
	return {
		text: label,
		className: text,
		verdict: verdictBesideStatus(run.status, judgement),
	};
}

/**
 * What the row says was run: the collection for a run with a `scenario` descriptor, else its URL. A
 * collection deleted since its run resolves to its id, the one thing the row still has; a
 * descriptor with no id has nothing to say, and the kind chip stands alone.
 */
function subjectOf(run: Run, collections: readonly Collection[]): string | undefined {
	const scenario = run.summary?.scenario;
	if (!scenario) return run.summary?.url;
	const id = scenario.collectionId;
	return id ? (collections.find((c) => c.id === id)?.name ?? id) : undefined;
}

export function RecentRuns({ runs }: { runs: Run[] }) {
	const openTab = useTabsStore((s) => s.openTab);
	const { data: collections = [] } = useCollectionsQuery();

	// Copy before sorting: `runs` is the TanStack Query cache array.
	const recent = [...runs]
		.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
		.slice(0, RECENT_RUN_LIMIT);

	if (recent.length === 0) return null;

	return (
		<section>
			<Eyebrow className="mb-2">Recent runs</Eyebrow>
			<div className="flex flex-col">
				{recent.map((run) => {
					const status = statusLabel(run);
					const isCollectionRun = run.summary?.scenario != null;
					const subject = subjectOf(run, collections);
					const method = isCollectionRun ? undefined : run.summary?.method;
					return (
						<Button
							key={run.id}
							type="button"
							variant="listRow"
							onClick={() => openTab({ type: "run", entityId: run.id })}
							aria-label={`Open ${RUN_TYPE_NAME[run.type]}${
								subject ? `, ${subject}` : ""
							}${status ? `, ${status.text.toLowerCase()}` : ""}${
								status?.verdict ? `, verdict ${status.verdict}` : ""
							}`}
							// Overrides the variant's `justify-start`: the row's identity and meta
							// groups split to the ends.
							className="group justify-between gap-3 px-2 py-1.5 hover:bg-accent"
						>
							<span className="flex min-w-0 flex-1 items-center gap-2">
								<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro font-mono font-semibold uppercase">
									{RUN_TYPE_NAME[run.type]}
								</span>
								{method && <MethodBadge method={method} size="sm" />}
								{subject ? (
									// `min-w-0` on the flex parent as well, or the URL
									// refuses to shrink and pushes the timestamp out.
									<TruncatedText className="text-xs text-foreground">
										{subject}
									</TruncatedText>
								) : (
									!isCollectionRun && (
										// Pre-snapshot runs, or a run stored without a URL: said,
										// so the row does not look broken.
										<span className="truncate text-xs text-muted-foreground italic">
											No URL recorded
										</span>
									)
								)}
							</span>
							<span className="flex shrink-0 items-center gap-2">
								{status && (
									<span className={`text-xs ${status.className}`}>
										{status.text}
									</span>
								)}
								{run.startTime > 0 && (
									<TimeValue
										value={run.startTime}
										style="relative"
										className="text-xs font-mono text-muted-foreground"
									/>
								)}
								<ChevronRight className="size-icon text-muted-foreground transition-colors group-hover:text-foreground" />
							</span>
						</Button>
					);
				})}
			</div>
		</section>
	);
}
