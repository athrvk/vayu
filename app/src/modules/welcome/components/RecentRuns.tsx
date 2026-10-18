/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RecentRuns
 *
 * Flat rows rather than cards - the card grid is what made the old screen read
 * as a landing page. Carries the app's existing run vocabulary (method badge,
 * type badge, status tokens, mono timestamps) so it matches the dashboard and
 * history views.
 *
 * Each row leads with what was run. Without that the list read "Load ·
 * Completed · 2 hours ago" five times over, with nothing to tell one row from
 * the next - you had to open a run to find out which one it was.
 *
 * The identifier is the method and URL from the run `summary`, which is what
 * the history sidebar shows for the same records. Not the request's *name*: a run
 * stores no name, and `requestId` is only set for design runs, so most rows -
 * every load test - would have nothing to look up. The snapshot's URL is
 * always there, and it is the truth about what was actually sent, even if the
 * request has since been renamed, edited or deleted.
 */

import { ChevronRight } from "lucide-react";
import { useTabsStore } from "@/stores";
import { MethodBadge, RUN_STATUS, TruncatedText } from "@/components/shared";
import { Button, Eyebrow } from "@/components/ui";
import { TimeValue } from "@/components/shared/TimeValue";
import type { Run } from "@/types";
import { RUN_TYPE_NAME } from "@/modules/history/types";

const RECENT_RUN_LIMIT = 5;

/**
 * Only a terminal status is called out here: the welcome screen lists what
 * happened, not what is in flight, so `running` and `pending` get no label.
 */
const SETTLED_STATUSES: ReadonlySet<Run["status"]> = new Set(["completed", "stopped", "failed"]);

/**
 * The word and `--status-*-text` token come from `RUN_STATUS`, the map the
 * history sidebar's `RunItem` and the run tab header draw with: two lists of the
 * same runs answering in two different colours is the drift it exists to prevent
 * (#1225).
 */
function statusLabel(status: Run["status"]): { text: string; className: string } | null {
	if (!SETTLED_STATUSES.has(status)) return null;
	const { label, text } = RUN_STATUS[status];
	return { text: label, className: text };
}

export function RecentRuns({ runs }: { runs: Run[] }) {
	const openTab = useTabsStore((s) => s.openTab);

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
					const status = statusLabel(run.status);
					const url = run.summary?.url;
					const method = run.summary?.method;
					return (
						<Button
							key={run.id}
							type="button"
							variant="listRow"
							onClick={() => openTab({ type: "run", entityId: run.id })}
							aria-label={`Open ${RUN_TYPE_NAME[run.type]}${
								url ? `, ${url}` : ""
							}${status ? `, ${status.text.toLowerCase()}` : ""}`}
							// `justify-between` overrides the variant's `justify-start`:
							// this row's two content groups (identity, meta) split to the
							// ends rather than packing left.
							className="group justify-between gap-3 px-2 py-1.5 hover:bg-accent"
						>
							<span className="flex min-w-0 flex-1 items-center gap-2">
								<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro font-mono font-semibold uppercase">
									{RUN_TYPE_NAME[run.type]}
								</span>
								{method && <MethodBadge method={method} size="sm" />}
								{url ? (
									// `min-w-0` on the flex parent as well, or the URL
									// refuses to shrink and pushes the timestamp out.
									<TruncatedText className="text-xs text-foreground">
										{url}
									</TruncatedText>
								) : (
									// Pre-snapshot runs, and anything the engine stored
									// without a URL. Say so rather than leaving the row
									// looking like it failed to render.
									<span className="truncate text-xs text-muted-foreground italic">
										No URL recorded
									</span>
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
