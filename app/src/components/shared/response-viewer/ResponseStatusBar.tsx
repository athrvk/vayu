/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bar above a response: status chip, elapsed time, payload size. One component for the request
 * builder and the stored viewer (time and size optional for the latter), as two copies drifted: one
 * lost `StatusCodeBadge`'s `status === 0` branch and printed a literal `0`, and a divider fix had
 * to be made twice.
 */

import { useEffect, useState } from "react";
import { Clock, FileText, History, ShieldCheck } from "lucide-react";
import { formatBytes } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import type { ResponseValidation } from "@/types";
import { TIMING } from "@/config/timing";
import { TimeValue } from "@/components/shared/TimeValue";
import type { TimeRow } from "@/lib/time-value";
import {
	ENGINE_COST_TIP,
	SCRIPT_TIME_TIP,
	elapsedBetween,
	formatResponseTime,
	isReportedMs,
	responseSizeTip,
} from "./utils";
import { HttpVersionDowngradeNote } from "./HttpVersionDowngradeNote";
import { StatusCodeBadge } from "./StatusCodeBadge";
import { ValidationChip } from "./ValidationChip";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface ResponseStatusBarProps {
	status: number;
	statusText?: string;
	/** Omitted by callers that have no timing - a stored run without a trace. */
	time?: number;
	/** Omitted by callers that have no size. */
	size?: number;
	/**
	 * The response headers, read only for the size hover (#2787): a Content-Length beside a
	 * Content-Encoding is the compressed length, which `size` is not.
	 */
	headers?: Record<string, string>;
	/**
	 * Vayu's own share of `time` (#2132), in ms (`timing.engineMs`); absent for a stream, an
	 * auth-failure reply and rows stored before the engine reported it, when the bar shows nothing
	 * rather than zero. Drawn beside `time`, so needs it.
	 */
	engineMs?: number;
	/**
	 * The scripts' share of the send (#3676), in ms (`timing.scriptMs`), outside `time` and
	 * `engineMs`; the bar draws it only above `wireMs`, when scripts, not the network, made the
	 * send slow. The Timing tab always shows it.
	 */
	scriptMs?: number;
	/** `timing.wireMs`, the bar of comparison for `scriptMs`. Absent: no script figure is drawn. */
	wireMs?: number;
	/**
	 * The negotiated protocol as a display string ("HTTP/1.1"), not the request-side `HttpVersion`
	 * union; read only with `httpVersionDowngraded`, as a response that got what it asked for shows
	 * none.
	 */
	httpVersion?: string;
	/**
	 * The request named `http2` and the connection negotiated older. The engine decides it
	 * (`http_version_downgraded`, `engine/include/vayu/http/curl_version_map.hpp`); the bar makes
	 * it visible, as a downgrade otherwise looks like success: three releases shipped with every
	 * Windows request downgraded and nothing here changed (#215).
	 */
	httpVersionDowngraded?: boolean;
	/**
	 * The client-certificate registry entry presented, as `host` or `host:port` (#707), absent when
	 * none matched; shown because a per-host registry decides it unmentioned by the request, so two
	 * calls to what looks like one API can differ only in the entry.
	 */
	clientCertificate?: string;
	/** ISO time this response arrived. Live sends only. */
	receivedAt?: string;
	/**
	 * Set when rebuilt from a stored run rather than sent now; the age chip below says why the
	 * difference shows.
	 */
	restoredFrom?: { runId?: string; at: string };
	/**
	 * A stream is open on this response, with its event count (#574). On the bar, not only the
	 * Events tab: a stream has no finished exchange, so `time` and `size` say nothing while it runs
	 * and the band would announce a 200 and look done. Omitted on non-live responses: a chip on
	 * every response is read by nobody. `sentAt` (epoch ms) is the stream's start: the time slot
	 * counts up from it, rather than `time`, which a stream holds at 0 (#3775).
	 */
	streaming?: { events: number; sentAt?: number };
	/**
	 * What schema checking found (#628); absent for a collection binding no OpenAPI document, when
	 * the bar shows nothing.
	 */
	validation?: ResponseValidation;
	className?: string;
}

/** Scripts are worth a place on the bar only once they outweigh the transfer. */
function scriptsDominate(scriptMs?: number, wireMs?: number): scriptMs is number {
	return isReportedMs(scriptMs) && isReportedMs(wireMs) && scriptMs > wireMs;
}

/**
 * The time since @p sentAt, recomputed on its own interval so only this text re-renders per tick;
 * torn down with the component, when the stream ends and the bar reverts to `time`.
 */
function ElapsedClock({ sentAt }: { sentAt: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), TIMING.STREAM_CLOCK_TICK_MS);
		return () => clearInterval(id);
	}, []);
	return <>{formatResponseTime(elapsedBetween(sentAt, now) ?? 0)}</>;
}

export function ResponseStatusBar({
	status,
	statusText,
	time,
	size,
	headers,
	engineMs,
	scriptMs,
	wireMs,
	httpVersion,
	httpVersionDowngraded,
	clientCertificate,
	receivedAt,
	restoredFrom,
	streaming,
	validation,
	className,
}: ResponseStatusBarProps) {
	/*
	 * A relative time must be recomputed to stay true; every other relative `TimeValue` renders
	 * once and says "now" while mounted. It matters most here, as the pane stays open while you
	 * edit the request beside it.
	 */
	const [, tick] = useState(0);
	const at = receivedAt ?? restoredFrom?.at;
	useEffect(() => {
		if (!at) return;
		const id = setInterval(() => tick((n) => n + 1), TIMING.RELATIVE_TIME_TICK_MS);
		return () => clearInterval(id);
	}, [at]);

	const age = at ? { at, fromRun: !!restoredFrom } : null;
	const restoredRows: TimeRow[] = restoredFrom
		? [
				{ label: "Source", value: "Restored from a stored run" },
				...(restoredFrom.runId ? [{ label: "Run", value: restoredFrom.runId }] : []),
			]
		: [];

	return (
		/*
		 * `border-rule`: the bar sits in the response pane's `surface-card`, which declares the
		 * rule. A border token made it invisible in dark (`--border` is `--card`'s colour, 1.003;
		 * index.css, "Surfaces, and the rule colour that reads on each").
		 */
		<div
			className={cn(
				/*
				 * `py-1.5`, on the `--spacing` rhythm rather than a fixed step, under the 32px
				 * `band` tab row (#1679). A band of its own, not folded into the tab row: a
				 * response's status is the first thing read, and a row shared with eight tab
				 * triggers and the actions is no place for a headline; the tint keeps the two
				 * similar rows from reading as one. It wraps (#3494): at a narrow pane or 200%
				 * scale the groups move to a second line whole, being `shrink-0 whitespace-nowrap`,
				 * as a shrinkable flex item breaks "120 ms" into a column first.
				 */
				"flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 border-b border-rule bg-muted/30",
				className
			)}
		>
			{/*
			 * Compact, so the chip does not make the band taller than its text; still the loudest
			 * thing in the row, the only one with a fill.
			 */}
			<StatusCodeBadge
				status={status}
				statusText={statusText}
				className="h-5 px-1.5 text-micro"
			/>

			{/*
			 * A live stream and its running count, first after the status chip, as the thing still
			 * happening; the numbers to its right describe an unfinished exchange. The pulsing dot
			 * is the load-test button's mark, as no static colour says "live".
			 */}
			{streaming && (
				<div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-status-success-text">
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-status-success animate-pulse"
					/>
					<span className="tabular-nums">
						Streaming - {streaming.events.toLocaleString()}{" "}
						{pluralize(streaming.events, "event")}
					</span>
				</div>
			)}

			{/*
			 * Beside the streaming chip among status, time and size, as it describes this exchange;
			 * text with an icon, not a `Badge`, painting no background (badge-hover.test.tsx's
			 * variant="chip" rule).
			 */}
			{validation && (
				<ValidationChip validation={validation} className="shrink-0 whitespace-nowrap" />
			)}

			{time !== undefined && (
				<div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
					<Clock className="size-icon-sm" />
					<span className="tabular-nums">
						{streaming?.sentAt !== undefined ? (
							<ElapsedClock sentAt={streaming.sentAt} />
						) : (
							formatResponseTime(time)
						)}
					</span>
					{/* Plain text, no `bg-`: see the variant="chip" rule in badge-hover.test.tsx. */}
					{isReportedMs(engineMs) && (
						<span className="tabular-nums" title={ENGINE_COST_TIP}>
							- {formatResponseTime(engineMs)} in Vayu
						</span>
					)}
					{scriptsDominate(scriptMs, wireMs) && (
						<span className="tabular-nums" title={SCRIPT_TIME_TIP}>
							- {formatResponseTime(scriptMs)} in scripts
						</span>
					)}
				</div>
			)}

			{size !== undefined && (
				<div
					className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
					title={responseSizeTip(headers)}
				>
					<FileText className="size-icon-sm" />
					<span className="tabular-nums">{formatBytes(size)}</span>
				</div>
			)}

			{/*
			 * Protocol downgrade, only when it happened, among status, time and size rather than at
			 * the end with the age, as it describes the exchange.
			 */}
			{httpVersionDowngraded && (
				<HttpVersionDowngradeNote
					httpVersion={httpVersion}
					className="shrink-0 whitespace-nowrap"
				/>
			)}

			{/*
			 * The client certificate offered (#707), only when one matched, as for the downgrade.
			 * "Offered", not "accepted": the server decides, and an `http://` send offers nothing,
			 * so never has it (#3260). Text, no background (badge-hover.test.tsx's variant="chip"
			 * rule).
			 */}
			{clientCertificate && (
				<div
					className="flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted-foreground"
					title={
						`Client certificate registered for ${clientCertificate} was offered ` +
						`(Settings › Network & connectivity).`
					}
				>
					<ShieldCheck className="size-icon-sm shrink-0" />
					<span className="truncate">mTLS: {clientCertificate}</span>
				</div>
			)}

			{/*
			 * Response age, for a restored *and* a live response. `time` beside it is how long the
			 * exchange took; this answers what a duration cannot: whether this answers the request
			 * beside it as it is now, or a version from several edits ago. Labelled apart: "from
			 * run" carries the run's identity and id in the tooltip; a live one is its age. Text,
			 * no `bg-`, so no Badge (badge-hover.test.tsx), at the far end rather than among the
			 * exchange's own figures.
			 */}
			{age && (
				<div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-label text-muted-foreground">
					{age.fromRun ? (
						<History className="size-icon-sm" />
					) : (
						<Clock className="size-icon-sm" />
					)}
					<span>
						{age.fromRun ? "from run - " : ""}
						<TimeValue value={age.at} style="relative" extraRows={restoredRows} />
					</span>
				</div>
			)}
		</div>
	);
}

export default ResponseStatusBar;
