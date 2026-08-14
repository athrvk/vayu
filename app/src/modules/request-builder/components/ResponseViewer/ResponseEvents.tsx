/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseEvents Component
 *
 * The Events tab: what a `text/event-stream` request received (issue #574).
 *
 * **Two sources, one list**, the handoff `ScenarioRunView` makes. While the
 * stream is open the rows come from `execution-events-store`, fed by the
 * relay; once it ends, the run's stored trace is the record and the provider
 * swaps them in. The changeover is decided by the caller, which knows which of
 * the two it is holding - this component renders whichever list it is given and
 * says which one that is.
 *
 * **The tab always renders**, on every response, per the constant-tab-set rule
 * the strip has followed since #59. A normal response gets an honest empty
 * state rather than a missing tab, which is also what makes "was this a
 * stream?" a question you can go and read.
 *
 * **Every disclosure is in band.** A stream that ended by a cap and one the
 * server closed are different facts, and a list of 100 rows out of 4,000
 * received is a different thing from a complete list of 100. Neither is left to
 * be inferred from the row count.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Radio } from "lucide-react";
import { Badge } from "@/components/ui";
import { Callout, EmptyState } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { StreamEndReason, StreamEvent } from "@/types";

export interface ResponseEventsProps {
	/** The events to render, oldest first. */
	events: StreamEvent[];
	/**
	 * Every event the run received. Differs from `events.length` when the list
	 * was capped, which is the whole reason it is carried separately.
	 */
	totalEvents?: number;
	/** The list is a prefix of what arrived. */
	eventsTruncated?: boolean;
	/** Why the stream ended, or undefined while it is still open. */
	endReason?: StreamEndReason;
	/** The stream is still open and rows are still arriving. */
	isStreaming?: boolean;
	/**
	 * Whether this response came from a streaming send at all. False for an
	 * ordinary response, which gets the "not an event stream" empty state
	 * rather than "no events yet" - they are different answers.
	 */
	isStream?: boolean;
	/** A transport failure on the relay, if the live stream hit one. */
	error?: string | null;
}

/**
 * What each termination means, in the user's terms.
 *
 * `completed` is the only one where the *server* decided; every other reason is
 * a bound this side applied, and a reader has to be able to tell "the stream
 * finished" from "we stopped listening" - they lead to different next actions.
 */
const END_REASON_NOTE: Record<StreamEndReason, { title: string; detail: string }> = {
	completed: {
		title: "Stream closed by the server",
		detail: "The server ended the stream. Everything it sent is here.",
	},
	stopped: {
		title: "Stream stopped",
		detail: "You stopped this stream. The server may have had more to send.",
	},
	maxStreamEvents: {
		title: "Event limit reached",
		detail: "The stream hit its event cap and was closed. Raise Stream Event Limit in Settings, or set a higher cap on this request.",
	},
	maxStreamDurationMs: {
		title: "Duration limit reached",
		detail: "The stream ran for its maximum duration and was closed. Raise Stream Duration Limit in Settings, or set a higher cap on this request.",
	},
	idleTimeout: {
		title: "Stream went quiet",
		detail: "Nothing arrived for the idle timeout, so the stream was closed. The connection may have been dropped upstream without being closed.",
	},
	error: {
		title: "Stream ended in an error",
		detail: "The stream did not finish cleanly. What arrived before it ended is here.",
	},
};

/**
 * Pretty-print a payload that parses as JSON; hand back anything else as-is.
 *
 * Not exported: a second export beside the component costs this file its fast
 * refresh, and the behaviour is reachable through the rendered row anyway
 * (`events-tab.test.tsx` expands one and reads the formatting).
 */
function formatEventData(data: string): string {
	try {
		return JSON.stringify(JSON.parse(data), null, 2);
	} catch {
		return data;
	}
}

/** `receivedAt` as a wall clock, or empty when the event carried none. */
function formatReceivedAt(receivedAt: number | undefined): string {
	if (typeof receivedAt !== "number") return "";
	return new Date(receivedAt).toLocaleTimeString();
}

/** One event: a summary row that expands to the full payload. */
function EventRow({ event, index }: { event: StreamEvent; index: number }) {
	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const at = formatReceivedAt(event.receivedAt);

	return (
		<div className="border-b border-rule last:border-b-0">
			<button
				type="button"
				onClick={() => setExpanded((e) => !e)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-muted/40 transition-colors"
			>
				<Chevron aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
				<span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
					{index + 1}
				</span>
				{/*
				 * `variant="chip"` because this Badge paints its own background:
				 * every other variant pairs `bg-x` with `hover:bg-x/80`, and
				 * tailwind-merge replaces `bg-*` but not `hover:bg-*`, so the
				 * caller's fill would win at rest and the variant's on hover.
				 */}
				<Badge variant="chip" className="shrink-0 bg-muted text-muted-foreground">
					{event.event}
				</Badge>
				{event.sourceId && (
					<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
						id {event.sourceId}
					</span>
				)}
				{/* `min-w-0` plus `truncate`, or the preview refuses to shrink and
				    pushes the timestamp out of the row. */}
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
					{event.data}
				</span>
				{event.dataTruncated && (
					<Badge variant="chip" className="shrink-0 bg-warning/20 text-warning-text">
						truncated
					</Badge>
				)}
				{at && (
					<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
						{at}
					</span>
				)}
			</button>
			{expanded && (
				<div className="px-4 pb-3 pl-16">
					{event.dataTruncated && (
						<p className="pb-2 text-xs text-warning-text">
							Only the first {event.data.length.toLocaleString()} bytes of{" "}
							{(event.dataBytes ?? event.data.length).toLocaleString()} were kept -
							raise Stream Event Size Limit in Settings to keep more.
						</p>
					)}
					<pre className="max-h-64 overflow-auto rounded-md surface-sunken border border-rule p-3 font-mono text-xs whitespace-pre-wrap break-all">
						{formatEventData(event.data)}
					</pre>
				</div>
			)}
		</div>
	);
}

export default function ResponseEvents({
	events,
	totalEvents,
	eventsTruncated,
	endReason,
	isStreaming = false,
	isStream = false,
	error = null,
}: ResponseEventsProps) {
	// Two different absences, two different answers. A response that was never a
	// stream has no timeline to show and never will; a stream that has produced
	// nothing yet is still going to.
	if (!isStream) {
		return (
			<EmptyState
				variant="inline"
				icon={Radio}
				title="Not an event stream"
				description="Turn on Event stream in the request's Settings tab to consume a text/event-stream endpoint live."
			/>
		);
	}

	const note = endReason ? END_REASON_NOTE[endReason] : null;
	// The received total, which is what the header counts. `totalEvents` is the
	// engine's own and outranks the row count whenever it is there.
	const received = totalEvents ?? events.length;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b border-rule px-4 py-2 shrink-0">
				{isStreaming && (
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 rounded-full bg-status-success animate-pulse"
					/>
				)}
				<span className="text-xs font-medium">
					{isStreaming ? "Streaming" : "Stream ended"}
				</span>
				<span className="text-xs text-muted-foreground">
					{received.toLocaleString()} {received === 1 ? "event" : "events"}
					{eventsTruncated && ` - showing ${events.length.toLocaleString()}`}
				</span>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{(error || note || eventsTruncated) && (
					<div className="space-y-2 p-4 pb-0">
						{error && (
							<Callout severity="warning" title="Lost the live stream">
								{error}
							</Callout>
						)}
						{note && (
							<Callout
								severity={endReason === "completed" ? "info" : "warning"}
								title={note.title}
							>
								{note.detail}
							</Callout>
						)}
						{eventsTruncated && (
							<Callout severity="warning" title="Events truncated for storage">
								{received.toLocaleString()} events were received and the first{" "}
								{events.length.toLocaleString()} were kept. Raise Stream Events
								Stored Per Run in Settings to keep more.
							</Callout>
						)}
					</div>
				)}

				{events.length === 0 ? (
					<EmptyState
						variant="inline"
						icon={Radio}
						title={isStreaming ? "Waiting for the first event" : "No events received"}
						description={
							isStreaming
								? "The stream is open and nothing has arrived yet."
								: "The stream opened but the server sent no events before it ended."
						}
					/>
				) : (
					<div className={cn(error || note || eventsTruncated ? "pt-2" : undefined)}>
						{events.map((event, i) => (
							// Index-keyed deliberately: the list only ever grows at the
							// end, and an event carries no id of its own that is unique
							// (`sourceId` is the origin's and repeats freely).
							<EventRow key={i} event={event} index={i} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
