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

import { useEffect, useState } from "react";
import { Clock, FileText, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { TIMING } from "@/config/timing";
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
	/** ISO time this response arrived. Live sends only. */
	receivedAt?: string;
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
	receivedAt,
	restoredFrom,
	className,
}: ResponseStatusBarProps) {
	/*
	 * A relative time has to be recomputed to stay true. Nothing else in the app
	 * does this - every other `formatRelativeTime` caller renders once and then
	 * says "just now" for as long as it stays mounted - and the restored-response
	 * chip here had the same rot. The response pane is where it matters most,
	 * because the pane sits open while you keep editing the request beside it.
	 */
	const [, tick] = useState(0);
	const at = receivedAt ?? restoredFrom?.at;
	useEffect(() => {
		if (!at) return;
		const id = setInterval(() => tick((n) => n + 1), TIMING.RELATIVE_TIME_TICK_MS);
		return () => clearInterval(id);
	}, [at]);

	const age = at
		? {
				at,
				fromRun: !!restoredFrom,
				title: restoredFrom
					? `Restored from a stored run - ${new Date(restoredFrom.at).toLocaleString()}` +
						(restoredFrom.runId ? `\nRun ${restoredFrom.runId}` : "")
					: `Received ${new Date(at).toLocaleString()}`,
			}
		: null;

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
			 * Response age - for a restored response *and* a live one.
			 *
			 * `time` beside it is a duration: how long the exchange took. This is
			 * a different question, and the one a duration cannot answer - whether
			 * what you are looking at is the response to the request beside it *as
			 * it is now*, or to a version of it from twenty minutes and several
			 * edits ago. A restored response used to be the only case that got an
			 * answer, which left the more common one - a response you sent, then
			 * kept editing around - reading as if it were current forever.
			 *
			 * The two are labelled apart: "from run" carries the run's identity
			 * and its id in the tooltip; a live one is just its age.
			 *
			 * No `bg-`, so no Badge - see the variant="chip" rule in
			 * badge-hover.test.tsx. It is text, and it sits at the far end rather
			 * than among status/time/size, which describe the exchange itself.
			 */}
			{age && (
				<div
					className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"
					title={age.title}
				>
					{age.fromRun ? <History className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
					<span>
						{age.fromRun ? "from run - " : ""}
						{formatRelativeTime(age.at)}
					</span>
				</div>
			)}
		</div>
	);
}

export default ResponseStatusBar;
