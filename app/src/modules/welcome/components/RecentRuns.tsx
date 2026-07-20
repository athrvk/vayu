/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RecentRuns
 *
 * Flat rows rather than cards — the card grid is what made the old screen read
 * as a landing page. Carries the app's existing run vocabulary (type badge,
 * status tokens, mono timestamps) so it matches the dashboard and history views.
 */

import { ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTabsStore } from "@/stores";
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
			return { text: "Failed", className: "text-destructive" };
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
					return (
						<button
							key={run.id}
							type="button"
							onClick={() => openTab({ type: "run", entityId: run.id })}
							className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="flex min-w-0 items-center gap-2">
								<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-mono font-bold uppercase">
									{run.type === "load" ? "Load" : "Design"}
								</span>
								{status && (
									<span className={`shrink-0 text-[12px] ${status.className}`}>
										{status.text}
									</span>
								)}
								{run.startTime > 0 && (
									<span className="truncate text-[12px] font-mono tabular-nums text-muted-foreground">
										{formatDistanceToNow(run.startTime, { addSuffix: true })}
									</span>
								)}
							</span>
							<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
						</button>
					);
				})}
			</div>
		</section>
	);
}
