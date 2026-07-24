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
import { formatDistanceToNow } from "date-fns";
import { useTabsStore } from "@/stores";
import { MethodBadge, TruncatedText } from "@/components/shared";
import type { Run } from "@/types";

const RECENT_RUN_LIMIT = 5;

/** Status text is shown only for terminal states worth calling out. */
function statusLabel(status: Run["status"]): { text: string; className: string } | null {
	switch (status) {
		case "completed":
			return { text: "Completed", className: "text-success-text" };
		case "stopped":
			return { text: "Stopped", className: "text-warning-text" };
		case "failed":
			return { text: "Failed", className: "text-destructive-text" };
		default:
			return null;
	}
}

export function RecentRuns({ runs }: { runs: Run[] }) {
	const { openTab } = useTabsStore();

	// Copy before sorting: `runs` is the TanStack Query cache array.
	const recent = [...runs]
		.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
		.slice(0, RECENT_RUN_LIMIT);

	if (recent.length === 0) return null;

	return (
		<section>
			<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
				Recent runs
			</p>
			<div className="flex flex-col">
				{recent.map((run) => {
					const status = statusLabel(run.status);
					const url = run.summary?.url;
					const method = run.summary?.method;
					return (
						<button
							key={run.id}
							type="button"
							onClick={() => openTab({ type: "run", entityId: run.id })}
							aria-label={`Open ${run.type === "load" ? "load test" : "request"} run${
								url ? `, ${url}` : ""
							}${status ? `, ${status.text.toLowerCase()}` : ""}`}
							className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="flex min-w-0 flex-1 items-center gap-2">
								<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase">
									{run.type === "load" ? "Load" : "Design"}
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
									<span className="text-xs font-mono tabular-nums text-muted-foreground">
										{formatDistanceToNow(run.startTime, { addSuffix: true })}
									</span>
								)}
								<ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
							</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}
