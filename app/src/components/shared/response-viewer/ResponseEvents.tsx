/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Events tab: what a `text/event-stream` request received (#574).
 *
 * **Two sources, one list**, the handoff `ScenarioRunView` makes: while the stream is open the rows
 * come from `execution-events-store`, fed by the relay; once it ends, the stored trace is the
 * record and the provider swaps it in. The caller, knowing which it holds, decides the changeover;
 * this renders the list it gets and says which it is. **A third source** (#657): a load run's
 * captured sample, its events parsed by the engine out of the stored body and served by
 * `GET /runs/:id/samples`, which is why this lives in `components/shared`.
 *
 * **The tab always renders**, on every response (the strip's constant-tab-set rule, #59): a normal
 * response gets an honest empty state, which makes "was this a stream?" readable. **The list is
 * windowed and its rows memoized** (#1158): a stream runs to 100,000 events by default, each row a
 * chip, a monospace preview and an expandable payload, so rows arrive in slices that grow as the
 * end is scrolled to, and an unchanged row does not re-render when later ones arrive.
 *
 * **A Text view beside the rows** (#3773) when the request declared a stream text path: the events'
 * `text`, joined, as the reply reads. It renders what the engine put on each event and never reads
 * `data`: with no provider shape known there is no finish-reason callout, only what the stream says
 * (an event the engine flagged `isError`, the end reason). **The judgement of what is an error is
 * the engine's, never made here** (#3996): the callout, the row chip and the header's count all read
 * the flag, so a stream whose error rides a `message` event is as visible as a named `error` one.
 * **Every disclosure is in band**: a capped stream and a
 * server-closed one are different facts, and 100 rows of 4,000 is not a complete 100; neither is
 * left to the row count.
 */

import { memo, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Rows3, TextAlignStart } from "lucide-react";
import {
	Badge,
	Button,
	Collapsible,
	CollapsibleContent,
	ToggleGroup,
	ToggleGroupItem,
} from "@/components/ui";
import { Callout, EmptyState } from "@/components/shared";
import { TimeValue } from "@/components/shared/TimeValue";
import { useGrowingWindow } from "@/hooks/useGrowingWindow";
import { formatJson } from "@/lib/json-format";
import { countErrorEvents } from "@/lib/stream-events";
import { cn } from "@/lib/utils";
import type { StreamEndReason, StreamEvent } from "@/types";
import { pluralize } from "@/modules/dashboard/utils/format";
import { isEventStreamType, mediaTypeOf } from "@/modules/request-builder/utils/response-bytes";
import { elapsedBetween, formatResponseTime } from "./utils";

export interface ResponseEventsProps {
	/** The events to render, oldest first. */
	events: StreamEvent[];
	/**
	 * Every event the run received, differing from `events.length` when the list was capped, the
	 * reason it is carried apart.
	 */
	totalEvents?: number;
	/** The list is a prefix of what arrived. */
	eventsTruncated?: boolean;
	/**
	 * The reply the stream text path read, joined over every event: the engine's string for a
	 * stored run, the store's running one live. It beats joining `events`, which the stored-items
	 * cap can cut short. Absent without a path (or, live, before a match), when the Text view shows
	 * only if an event carries `text`.
	 */
	streamText?: string;
	/**
	 * How many of `events` carry the engine's `isError` flag. The live caller passes the store's
	 * running count, so a 100,000-event list is not re-walked per batch; absent, it is counted from
	 * `events`, which for a stored list is the kept ones.
	 */
	errorCount?: number;
	/** Why the stream ended, or undefined while it is still open. */
	endReason?: StreamEndReason;
	/** The stream is still open and rows are still arriving. */
	isStreaming?: boolean;
	/**
	 * Whether this response came from a streaming send; false gets the "not an event stream" empty
	 * state, not "no events yet", a different answer.
	 */
	isStream?: boolean;
	/**
	 * The server's `Content-Type`, when known, read only for the empty state: a stream request
	 * whose reply was not an event stream (a JSON 404, NDJSON) has no events and never will, and
	 * "the server sent no events" would hide that the reply is on the Body tab (#3238). Absent or
	 * empty keeps the generic wording.
	 */
	contentType?: string;
	/**
	 * When the stream started, epoch ms (#3775): a row's offset is its `receivedAt` less this.
	 * Absent without a send time (a stream restored from History, a load run's sampled capture),
	 * when rows show no offset rather than one measured from a guess.
	 */
	sentAt?: number;
	/** A transport failure on the relay, if the live stream hit one. */
	error?: string | null;
	/**
	 * What identifies the list for the render window (#1158), which resets when this changes. A
	 * live stream passes its run id, as its list grows in place and the default (the row count)
	 * would reset the window to its first slice on every batch; a list arriving whole (a stored
	 * trace, a load run's captured sample) wants that default.
	 */
	listKey?: string;
}

/**
 * Each termination in the user's terms. `completed` is the only one the *server* decided; every
 * other is a bound this side applied, or the engine going down (`shutdown`, not the user's
 * `stopped`), and "the stream finished" versus "we stopped listening" lead to different next
 * actions.
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
		detail: "The stream hit its event cap and was closed. Raise Stream event limit in Settings, or set a higher cap on this request.",
	},
	maxStreamDurationMs: {
		title: "Duration limit reached",
		detail: "The stream ran for its maximum duration and was closed. Raise Stream duration limit in Settings, or set a higher cap on this request.",
	},
	idleTimeout: {
		title: "Stream went quiet",
		detail: "Nothing arrived for the idle timeout, so the stream was closed. The connection may have been dropped upstream without being closed.",
	},
	shutdown: {
		title: "Vayu's engine shut down",
		detail: "Vayu's engine shut down, so the stream was closed. The server may have had more to send. What arrived before then is here.",
	},
	error: {
		title: "Stream ended in an error",
		detail: "The stream did not finish cleanly. What arrived before it ended is here.",
	},
};

/**
 * Pretty-prints a payload parsing as JSON, else returns it as-is. Not exported: a second export
 * costs the file fast refresh, and the rendered row reaches it (`events-tab.test.tsx` expands one
 * and reads the formatting).
 */
function formatEventData(data: string): string {
	return formatJson(data);
}

/**
 * The server's `type/subtype` when not an event stream, else `undefined` (no header, or one naming
 * `text/event-stream`; a `; charset=` does not change that).
 */
function nonEventStreamType(contentType: string | undefined): string | undefined {
	if (!contentType) return undefined;
	const { type, subtype } = mediaTypeOf(contentType);
	if (!type || !subtype) return undefined;
	return isEventStreamType(contentType) ? undefined : `${type}/${subtype}`;
}

/** The empty state of a stream that has no rows, by what the server answered. */
function emptyTitle(isStreaming: boolean, otherMediaType: string | undefined): ReactNode {
	if (otherMediaType) {
		return (
			<>
				The server answered <code className="font-mono">{otherMediaType}</code>, not an
				event stream - see Body.
			</>
		);
	}
	return isStreaming
		? "Waiting for the first event. The stream is open and nothing has arrived yet."
		: "No events received. The stream opened but the server sent no events before it ended.";
}

type EventsView = "rows" | "text";

/** Error events past this many are counted, not listed. */
const MAX_ERROR_CALLOUTS = 3;
/** Longest stretch of an error event's data shown in its callout. */
const ERROR_DATA_PREVIEW = 400;

/** Whether the Text view has anything to be about: a joined string or an event's `text`. */
function hasStreamText(events: readonly StreamEvent[], streamText: string | undefined): boolean {
	return streamText !== undefined || events.some((event) => event.text !== undefined);
}

/** The reply as the Text view shows it: the engine's joined string, else the kept events'. */
function replyText(events: readonly StreamEvent[], streamText: string | undefined): string {
	return streamText ?? events.map((event) => event.text ?? "").join("");
}

/** The events the engine flagged `isError`: a mid-stream failure, judged without a provider's shape. */
function errorEventsOf(events: readonly StreamEvent[]): StreamEvent[] {
	return events.filter((event) => event.isError === true);
}

/** The reply, and what the stream said went wrong while it was being written. */
function StreamTextView({
	text,
	errors,
	isStreaming,
}: {
	text: string;
	errors: readonly StreamEvent[];
	isStreaming: boolean;
}) {
	const unlisted = errors.length - MAX_ERROR_CALLOUTS;
	return (
		<div className="space-y-3 p-4">
			{errors.slice(0, MAX_ERROR_CALLOUTS).map((event, i) => (
				<Callout key={i} severity="warning" title="The server sent an error event">
					<span className="font-mono break-all">
						{event.data.length > ERROR_DATA_PREVIEW
							? `${event.data.slice(0, ERROR_DATA_PREVIEW)}…`
							: event.data}
					</span>
				</Callout>
			))}
			{unlisted > 0 && (
				<p className="text-xs text-muted-foreground">
					{unlisted.toLocaleString()} more {pluralize(unlisted, "error event")} in Rows.
				</p>
			)}
			{text === "" ? (
				<EmptyState
					variant="inline"
					title={
						isStreaming
							? "Waiting for text. No event has matched the stream text path yet."
							: "No text. No event matched the stream text path."
					}
				/>
			) : (
				<p
					data-testid="stream-text"
					className="text-sm leading-relaxed whitespace-pre-wrap break-words"
				>
					{text}
				</p>
			)}
		</div>
	);
}

/**
 * A row's "+1.50 s" / "+120 ms" figure, with the words a screen reader and hover need to say what
 * it is measured from.
 */
function EventElapsed({ ms, since }: { ms: number; since: string }) {
	return (
		<span
			className="shrink-0 font-mono text-label text-muted-foreground"
			title={`Since ${since}`}
		>
			+{formatResponseTime(ms)}
			<span className="sr-only"> since {since}</span>
		</span>
	);
}

/**
 * One event, a summary row expanding to the full payload. Memoized, as a live stream re-renders the
 * list around it (#1158): up to a window of these are mounted while rows arrive several times a
 * second, all but the newest unchanged. Every prop keeps its identity (an event is appended once
 * and never replaced; the rest are numbers), so the default shallow comparison suffices, and a
 * custom comparator would be a second copy of that fact.
 */
const EventRow = memo(function EventRow({
	event,
	index,
	sentAt,
	previousReceivedAt,
}: {
	event: StreamEvent;
	index: number;
	sentAt?: number;
	previousReceivedAt?: number;
}) {
	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const offset = elapsedBetween(sentAt, event.receivedAt);
	const gap = elapsedBetween(previousReceivedAt, event.receivedAt);

	return (
		<div className="border-b border-rule last:border-b-0">
			<Collapsible open={expanded} onOpenChange={setExpanded}>
				<Button
					type="button"
					variant="listRow"
					onClick={() => setExpanded((e) => !e)}
					aria-expanded={expanded}
					// The `Button` baseline gives the row its transitions (index.css's
					// `:where(button, ...)`), and the chevron's own `size-icon-sm` (#1679) is left
					// alone by the primitive's `[&_svg:not([class*='size-'])]:size-icon`.
					// `rounded-none` overrides `rounded-md`: the row is full-bleed in its list
					// (`border-b last:border-b-0`), where a rounded hover would float.
					className="gap-2 rounded-none px-4 py-1.5 hover:bg-muted/40"
				>
					<Chevron
						aria-hidden="true"
						className="size-icon-sm shrink-0 text-muted-foreground"
					/>
					<span className="w-10 shrink-0 text-right font-mono text-label text-muted-foreground">
						{index + 1}
					</span>
					{/*
					 * `variant="chip"`, as this Badge paints its own background: other variants
					 * pair `bg-x` with `hover:bg-x/80`, and tailwind-merge keeps `hover:bg-*`, so
					 * the caller's fill would win at rest and the variant's on hover.
					 */}
					<Badge variant="chip" className="shrink-0 bg-muted text-muted-foreground">
						{event.event}
					</Badge>
					{event.isError && (
						<Badge variant="chip" className="shrink-0 bg-status-error-fill text-white">
							error
						</Badge>
					)}
					{event.sourceId && (
						<span className="shrink-0 font-mono text-label text-muted-foreground">
							id {event.sourceId}
						</span>
					)}
					{/*
					 * `min-w-0` plus `truncate`, or the preview will not shrink and pushes the
					 * timestamp out.
					 */}
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
						{event.data}
					</span>
					{event.dataTruncated && (
						<Badge variant="chip" className="shrink-0 bg-warning/20 text-warning-text">
							truncated
						</Badge>
					)}
					{offset !== undefined && <EventElapsed ms={offset} since="the send" />}
					{gap !== undefined && <EventElapsed ms={gap} since="the previous event" />}
					{typeof event.receivedAt === "number" && (
						<TimeValue
							value={event.receivedAt}
							style="time"
							className="shrink-0 font-mono text-label text-muted-foreground"
						/>
					)}
				</Button>
				<CollapsibleContent>
					<div className="px-4 pt-1 pb-3 pl-16">
						{event.dataTruncated && (
							<p className="pb-2 text-xs text-warning-text">
								Only the first {event.data.length.toLocaleString()} bytes of{" "}
								{(event.dataBytes ?? event.data.length).toLocaleString()} were kept
								- raise Stream event size limit in Settings to keep more.
							</p>
						)}
						<pre className="max-h-64 overflow-auto rounded-md surface-sunken border border-rule p-3 font-mono text-xs whitespace-pre-wrap break-all">
							{formatEventData(event.data)}
						</pre>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
});

export default function ResponseEvents({
	events,
	totalEvents,
	eventsTruncated,
	streamText,
	errorCount,
	endReason,
	isStreaming = false,
	isStream = false,
	contentType,
	sentAt,
	error = null,
	listKey,
}: ResponseEventsProps) {
	/*
	 * A slice grown as the end is reached, as the console and a scenario run's steps do (#1158): a
	 * stream caps at 100,000 events by default and ten million at the ceiling, and each row is
	 * DOM-heavy (a chip, a monospace preview, an expandable payload).
	 */
	const { visible, sentinelRef, hasMore } = useGrowingWindow(
		events.length,
		undefined,
		listKey ?? events.length
	);

	// The user's pick, or none: Text opens by default once there is any, as a request declaring a
	// path asks for the reply, not the frames.
	const [chosenView, setChosenView] = useState<EventsView | null>(null);
	const hasText = useMemo(() => hasStreamText(events, streamText), [events, streamText]);
	const view: EventsView = hasText ? (chosenView ?? "text") : "rows";
	const showText = view === "text";
	const text = useMemo(
		() => (showText ? replyText(events, streamText) : ""),
		[showText, events, streamText]
	);
	const errorEvents = useMemo(() => (showText ? errorEventsOf(events) : []), [showText, events]);
	const errorTotal = useMemo(() => errorCount ?? countErrorEvents(events), [errorCount, events]);

	// Two absences, two answers: a response that was never a stream has no timeline and never will;
	// a stream that produced nothing yet still may.
	if (!isStream) {
		return (
			<EmptyState
				variant="inline"
				title="Not an event stream. Turn on Event stream in the request's Settings tab to consume a text/event-stream endpoint live."
			/>
		);
	}

	const note = endReason ? END_REASON_NOTE[endReason] : null;
	// The received total, which the header counts; the engine's `totalEvents` beats the row count.
	const received = totalEvents ?? events.length;
	const otherMediaType = nonEventStreamType(contentType);
	// The engine joins `streamText` over every stored event, so a capped list does not shorten it;
	// without one, the text is only as long as the list.
	const showCutNotice = !!eventsTruncated && !(showText && streamText !== undefined);

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
					{received.toLocaleString()} {pluralize(received, "event")}
					{eventsTruncated && ` - showing ${events.length.toLocaleString()}`}
				</span>
				{errorTotal > 0 && (
					<span className="text-xs text-status-error-text">
						{errorTotal.toLocaleString()} {pluralize(errorTotal, "error")}
					</span>
				)}
				{hasText && (
					<ToggleGroup
						value={view}
						// Radix clears the value when the active item is pressed again; a view has
						// no "off".
						onValueChange={(next) => next && setChosenView(next as EventsView)}
						size="xs"
						aria-label="Events view"
						className="ml-auto"
					>
						<ToggleGroupItem value="rows">
							<Rows3 className="size-icon-sm" />
							Rows
						</ToggleGroupItem>
						<ToggleGroupItem value="text">
							<TextAlignStart className="size-icon-sm" />
							Text
						</ToggleGroupItem>
					</ToggleGroup>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{(error || note || showCutNotice) && (
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
						{showCutNotice && (
							<Callout severity="warning" title="Events truncated for storage">
								{received.toLocaleString()} events were received and the first{" "}
								{events.length.toLocaleString()} were kept.{" "}
								{showText &&
									"The text below joins only those, so it stops where they do. "}
								Raise Stream events stored per run in Settings to keep more.
							</Callout>
						)}
					</div>
				)}

				{showText ? (
					<StreamTextView text={text} errors={errorEvents} isStreaming={isStreaming} />
				) : events.length === 0 ? (
					<EmptyState variant="inline" title={emptyTitle(isStreaming, otherMediaType)} />
				) : (
					<div className={cn(error || note || showCutNotice ? "pt-2" : undefined)}>
						{events.slice(0, visible).map((event, i) => (
							// Index-keyed deliberately: the list only grows at the end, and an
							// event has no unique id (`sourceId` is its origin's and repeats).
							<EventRow
								key={i}
								event={event}
								index={i}
								sentAt={sentAt}
								previousReceivedAt={events[i - 1]?.receivedAt}
							/>
						))}
						{hasMore && (
							/*
							 * The sentinel: reaching it renders the next slice, so nothing is
							 * withheld. The count is stated rather than left to a scrollbar, as the
							 * console's is.
							 */
							<p
								ref={sentinelRef}
								className="border-t border-rule px-4 py-2 text-xs text-muted-foreground"
							>
								Showing {Math.min(visible, events.length).toLocaleString()} of{" "}
								{events.length.toLocaleString()} rows - scroll for more.
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
