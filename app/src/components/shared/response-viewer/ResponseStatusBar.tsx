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
import { AlertTriangle, Clock, FileText, History } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResponseValidation } from "@/types";
import { TIMING } from "@/config/timing";
import { formatRelativeTime } from "@/utils";
import { formatResponseTime, formatSize } from "./utils";
import { StatusCodeBadge } from "./StatusCodeBadge";
import { ValidationChip } from "./ValidationChip";

export interface ResponseStatusBarProps {
	status: number;
	statusText?: string;
	/** Omitted by callers that have no timing - a stored run without a trace. */
	time?: number;
	/** Omitted by callers that have no size. */
	size?: number;
	/**
	 * The protocol this exchange negotiated - a display string ("HTTP/1.1"),
	 * not the request-side `HttpVersion` union. Only read when
	 * `httpVersionDowngraded` is set; the bar does not show the protocol of a
	 * response that got the one it asked for.
	 */
	httpVersion?: string;
	/**
	 * The request named `http2` and the connection negotiated something older.
	 *
	 * The engine decides this (`http_version_downgraded`,
	 * `engine/include/vayu/http/curl_version_map.hpp`); the bar's only job is to
	 * stop it being invisible. Until this existed a downgrade was
	 * indistinguishable from success - a 200, a latency, a size, and no hint
	 * that the protocol on the request was not the protocol on the wire. Three
	 * releases shipped with every Windows request downgraded this way and
	 * nothing on this bar changed (issue #215).
	 */
	httpVersionDowngraded?: boolean;
	/** ISO time this response arrived. Live sends only. */
	receivedAt?: string;
	/**
	 * Set when this response was rebuilt from a stored run rather than sent just
	 * now. See the age chip below for why the difference is shown.
	 */
	restoredFrom?: { runId?: string; at: string };
	/**
	 * A stream is open on this response, and how many events have arrived
	 * (issue #574).
	 *
	 * On the bar rather than only in the Events tab because a stream has no
	 * completed exchange to describe: `time` and `size` say nothing while it
	 * runs, and without this the band would announce a 200 and then look
	 * finished for as long as the stream kept going. Omitted entirely on a
	 * response that is not a live stream - a chip present on every response is a
	 * chip nobody reads.
	 */
	streaming?: { events: number };
	/**
	 * What checking this response against its declared schema found (issue
	 * #628). Absent for a request whose collection binds no OpenAPI document -
	 * the bar then shows nothing, because there is nothing to say.
	 */
	validation?: ResponseValidation;
	className?: string;
}

export function ResponseStatusBar({
	status,
	statusText,
	time,
	size,
	httpVersion,
	httpVersionDowngraded,
	receivedAt,
	restoredFrom,
	streaming,
	validation,
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

			{/*
			 * A live stream, and its running count. First after the status chip
			 * because while it is there it is the thing that is still happening -
			 * the numbers to its right describe an exchange that has not finished.
			 * The pulsing dot is the same mark the load-test button uses, for the
			 * same reason: no static colour says "live".
			 */}
			{streaming && (
				<div className="flex items-center gap-1.5 text-xs text-status-success-text">
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-status-success animate-pulse"
					/>
					<span className="tabular-nums">
						Streaming - {streaming.events.toLocaleString()}{" "}
						{streaming.events === 1 ? "event" : "events"}
					</span>
				</div>
			)}

			{/*
			 * Beside the streaming chip and among status/time/size, because like
			 * them it describes this exchange. Text with an icon rather than a
			 * `Badge`: it paints no background, and the variant="chip" rule in
			 * badge-hover.test.tsx is for the ones that do.
			 */}
			{validation && <ValidationChip validation={validation} />}

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
			 * Protocol downgrade. Shown only when it happened - a response that
			 * negotiated what it asked for says nothing here, because a chip
			 * present on every response is a chip nobody reads.
			 *
			 * Text, not a `Badge`: it paints no background, and the
			 * variant="chip" rule in badge-hover.test.tsx exists precisely for
			 * the ones that do. It sits among status/time/size rather than at
			 * the far end with the age, because like them it describes the
			 * exchange itself.
			 */}
			{httpVersionDowngraded && (
				<div
					className="flex items-center gap-1.5 text-xs text-status-warning-text"
					title={
						`HTTP/2 was requested, but the connection negotiated ` +
						`${httpVersion || "an older protocol"}.\n` +
						`Timings and throughput below describe that connection, not HTTP/2.`
					}
				>
					<AlertTriangle className="w-3.5 h-3.5" />
					<span>{httpVersion || "HTTP/1.1"}, not HTTP/2</span>
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
