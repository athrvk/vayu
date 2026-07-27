/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bar above a response: status chip, elapsed time, payload size.
 *
 * This existed twice - `ResponseViewer/ResponseHeader.tsx` in the request
 * builder and a local `ResponseStatusBar` at the bottom of
 * `UnifiedResponseViewer` - as the same wrapper and the same three children,
 * class for class. The only difference was that the history copy made time and
 * size optional, so this takes the superset.
 *
 * It is the same duplication that produced the `status === 0` drift in
 * `StatusCodeBadge` (one copy lost the branch and rendered a literal `0`), and
 * the reason the invisible-divider fix had to be applied to this bar twice.
 */

import { Clock, FileText, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils";
import { formatResponseTime, formatSize } from "./utils";
import { StatusCodeBadge } from "./StatusCodeBadge";

export interface ResponseStatusBarProps {
	status: number;
	statusText?: string;
	/** Omitted by callers that have no timing - a stored run without a trace. */
	time?: number;
	/** Omitted by callers that have no size. */
	size?: number;
	/**
	 * Set when this response was rebuilt from a stored run rather than sent just
	 * now. See the age chip below for why the difference is shown.
	 */
	restoredFrom?: { runId?: string; at: string };
	className?: string;
}

export function ResponseStatusBar({
	status,
	statusText,
	time,
	size,
	restoredFrom,
	className,
}: ResponseStatusBarProps) {
	return (
		/*
		 * `border-rule`: this bar sits inside the response pane's `surface-card`,
		 * which declares what the rule resolves to. Hardcoding a border token here
		 * is what made it invisible in dark - `--border` is the same colour as
		 * `--card`, 1.003. See index.css, "Surfaces, and the rule colour that
		 * reads on each".
		 */
		<div
			className={cn(
				/*
				 * `py-1.5`, not `py-3`. This was the loosest padding left in the
				 * builder - a 40px band above a 24px tab row - while everything
				 * around it had been taken to `py-1`/`py-1.5`. It is 32px now.
				 *
				 * It stays a band rather than folding into the tab row below: the
				 * status of a response is the first thing you look at, and a row
				 * shared with eight tab triggers and the action buttons is not
				 * where a headline goes. The tint is what keeps two stacked rows
				 * of similar height from reading as one repeated thing.
				 */
				"flex items-center gap-3 px-4 py-1.5 border-b border-rule bg-muted/30",
				className
			)}
		>
			{/* Compact, to hold the band at 32px. It is still the loudest thing
			    in the row - it is the only thing here carrying a fill. */}
			<StatusCodeBadge
				status={status}
				statusText={statusText}
				className="h-5 px-1.5 text-[10px]"
			/>

			{time !== undefined && (
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Clock className="w-3.5 h-3.5" />
					<span className="tabular-nums">{formatResponseTime(time)}</span>
				</div>
			)}

			{size !== undefined && (
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<FileText className="w-3.5 h-3.5" />
					<span className="tabular-nums">{formatSize(size)}</span>
				</div>
			)}

			{/*
			 * Response age.
			 *
			 * Without it, a response restored from a stored run reads exactly
			 * like one that just came back, while the request editor beside it
			 * shows the request as it is now, possibly edited since. The
			 * relative form is what the History sidebar says about the same run;
			 * the exact time and the run id go in the tooltip.
			 *
			 * No `bg-`, so no Badge - see the variant="chip" rule in
			 * badge-hover.test.tsx. It is text, and it sits at the far end
			 * rather than among status/time/size, which describe the exchange
			 * itself.
			 */}
			{restoredFrom && (
				<div
					className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"
					title={
						`Restored from a stored run - ${new Date(restoredFrom.at).toLocaleString()}` +
						(restoredFrom.runId ? `\nRun ${restoredFrom.runId}` : "")
					}
				>
					<History className="h-3 w-3" />
					<span>from run - {formatRelativeTime(restoredFrom.at)}</span>
				</div>
			)}
		</div>
	);
}

export default ResponseStatusBar;
