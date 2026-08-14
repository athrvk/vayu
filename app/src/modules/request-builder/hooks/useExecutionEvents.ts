/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tail a streaming request's events (issue #574).
 *
 * `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and the
 * upstream's events arrive over that URL as SSE. This hook owns exactly one
 * such subscription - the one `execution-events-store` is holding - and writes
 * every frame into that store.
 *
 * **A per-endpoint `EventSource`, not the `SSEClient` singleton.** That client
 * belongs to load and scenario runs: it is a single connection whose lifetime
 * is the dashboard's, and it deliberately does not reconnect. Neither property
 * fits here. The shape this follows instead is `useInboxLive`'s, for the reason
 * that hook was written (#506): `EventSource` treats any non-200 as fatal and
 * never retries it, and a reconnect landing inside the engine's dead-socket
 * window meets a `409 run_events_in_use` from the claim the previous socket is
 * still holding - so one unlucky disconnect would end the stream for the life
 * of the tab, silently.
 *
 * A resume is safe to re-deliver in one direction only, so the resume point is
 * tracked rather than the ring replayed: `?lastEventId=` picks up at the frame
 * *after* the one named, so a dropped consumer re-renders nothing. Frame ids
 * start at 0 and the store appends blindly, so replaying from the start would
 * double every row.
 */

import { useEffect, useRef } from "react";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { useExecutionEventsStore } from "@/stores";
import {
	STREAM_END_REASONS,
	type StreamEndReason,
	type StreamEvent,
	type StreamOpen,
} from "@/types";

/** Reconnect attempts before the surface says the stream is gone. */
export const EXECUTION_EVENTS_MAX_RETRIES = 5;
/** First backoff step; each attempt doubles it, up to the cap. */
export const EXECUTION_EVENTS_RETRY_BASE_MS = 400;
export const EXECUTION_EVENTS_RETRY_MAX_MS = 5000;

/**
 * How long to wait before reconnect attempt @p attempt (1-based).
 *
 * The first step has to outlast the engine's stale-claim window - the previous
 * consumer's claim is held until two keep-alive intervals have passed without a
 * write - because a reconnect inside it is refused with a 409. The app cannot
 * read that setting, so the backoff doubles rather than guessing it. Jitter
 * keeps several watchers from retrying in lockstep.
 */
export function executionEventsRetryDelayMs(
	attempt: number,
	random: () => number = Math.random
): number {
	const step = Math.min(
		EXECUTION_EVENTS_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
		EXECUTION_EVENTS_RETRY_MAX_MS
	);
	return Math.round(step + random() * step * 0.5);
}

/** Narrow one relay `open` payload, or reject it. */
export function parseOpenFrame(raw: unknown): StreamOpen | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	// `statusCode` is what the status bar renders. A frame without one says
	// nothing about what the stream connected to, so it is dropped rather than
	// defaulted into a "0" the pane would draw as a client error.
	if (typeof e.statusCode !== "number") return null;
	return {
		statusCode: e.statusCode,
		statusText: typeof e.statusText === "string" ? e.statusText : "",
		headers:
			typeof e.headers === "object" && e.headers !== null
				? (e.headers as Record<string, string>)
				: {},
	};
}

/**
 * Narrow one relayed upstream event, or reject it.
 *
 * `data` is the row's whole content and `event` is what it is labelled with, so
 * a frame missing either is dropped rather than defaulted - a row reading
 * `message` with an empty body claims an event the origin never sent. An event
 * whose `data` is genuinely empty arrives as `""`, which is a string and passes.
 */
export function parseMessageFrame(raw: unknown): StreamEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	if (typeof e.event !== "string" || typeof e.data !== "string") return null;
	return {
		event: e.event,
		data: e.data,
		...(typeof e.sourceId === "string" && { sourceId: e.sourceId }),
		...(typeof e.receivedAt === "number" && { receivedAt: e.receivedAt }),
		...(e.dataTruncated === true && { dataTruncated: true }),
		...(typeof e.dataBytes === "number" && { dataBytes: e.dataBytes }),
	};
}

const isEndReason = (value: unknown): value is StreamEndReason =>
	typeof value === "string" && (STREAM_END_REASONS as readonly string[]).includes(value);

/** Narrow the relay's `complete` payload; an unreadable one still ends the stream. */
export function parseCompleteFrame(raw: unknown): {
	reason: StreamEndReason;
	totalEvents: number | null;
} {
	const e = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return {
		// A reason this app does not know is reported as `error` rather than
		// invented: the tab says why every stream ended, and "the engine said
		// something I could not read" is closer to an error than to a clean close.
		reason: isEndReason(e.reason) ? e.reason : "error",
		totalEvents: typeof e.totalEvents === "number" ? e.totalEvents : null,
	};
}

/**
 * Subscribe to the stream `execution-events-store` is holding.
 *
 * Called once, by `RequestBuilderProvider`. It takes no arguments because the
 * store already names the subscription: one stream at a time, and starting
 * another is what ends this one.
 */
export function useExecutionEvents(): void {
	const runId = useExecutionEventsStore((s) => s.runId);
	const eventsUrl = useExecutionEventsStore((s) => s.eventsUrl);
	const isStreaming = useExecutionEventsStore((s) => s.isStreaming);

	// Survives the effect re-running, and is keyed by run: a frame id belongs to
	// the relay that issued it.
	const resumeFrom = useRef<{ runId: string | null; lastEventId: string }>({
		runId: null,
		lastEventId: "",
	});

	useEffect(() => {
		// `isStreaming` gates as well as `runId`: once the stream has ended the
		// store keeps its rows for the pane to read, and re-opening the relay for
		// a finished run would replay the whole ring into a list that already has
		// it.
		if (!runId || !eventsUrl || !isStreaming) return;

		if (resumeFrom.current.runId !== runId) {
			resumeFrom.current = { runId, lastEventId: "" };
		}

		const store = useExecutionEventsStore.getState();
		let source: EventSource | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let cancelled = false;
		// Set by the `complete` frame. The relay closes the socket right after
		// it, and that close must not be read as a drop worth retrying.
		let ended = false;

		/** Remember where to resume, for every frame that carries an id. */
		const noteFrame = (event: MessageEvent) => {
			if (event.lastEventId) resumeFrom.current = { runId, lastEventId: event.lastEventId };
		};

		/** Parse a frame's JSON, or answer null. A frame this engine wrote parses. */
		const payloadOf = (event: MessageEvent): unknown => {
			try {
				return JSON.parse(event.data);
			} catch {
				return null;
			}
		};

		const connect = () => {
			// `Last-Event-ID` is a header the browser sets on its own reconnect and
			// that no API lets us set on a fresh connection, so ours travels as a
			// query parameter the engine reads on the same terms.
			const { lastEventId } = resumeFrom.current;
			const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
			source = new EventSource(`${API_ENDPOINTS.BASE_URL}${eventsUrl}${query}`);

			source.addEventListener("open", (event) => {
				// The relay's own `open` *frame*, not `EventSource`'s connection
				// event - they share a name and mean different things. Only a frame
				// carries data, which is how they are told apart.
				if (!(event instanceof MessageEvent)) {
					attempts = 0;
					return;
				}
				noteFrame(event);
				const open = parseOpenFrame(payloadOf(event));
				if (open) store.noteOpen(runId, open);
			});

			source.onmessage = (event) => {
				noteFrame(event);
				const parsed = parseMessageFrame(payloadOf(event));
				if (parsed) store.addEvent(runId, parsed);
			};

			source.addEventListener("complete", (event) => {
				ended = true;
				const { reason, totalEvents } =
					event instanceof MessageEvent
						? parseCompleteFrame(payloadOf(event))
						: { reason: "error" as const, totalEvents: null };
				store.endStream(runId, reason, totalEvents);
				source?.close();
				source = null;
			});

			source.onerror = () => {
				// The socket closing *after* a `complete` is the stream ending
				// normally, not a drop.
				if (ended || cancelled) {
					source?.close();
					source = null;
					return;
				}
				source?.close();
				source = null;

				if (attempts >= EXECUTION_EVENTS_MAX_RETRIES) {
					// Ended rather than left open: the reconnects are spent, so
					// nothing more is coming and a pane that kept saying "streaming"
					// would be lying. `error` is the honest reason - the engine may
					// well still be receiving events we can no longer see, and the
					// stored trace is what will say what it got.
					store.setError(
						runId,
						"Lost the event stream and could not reconnect. The run's stored events are still recorded."
					);
					store.endStream(runId, "error", null);
					return;
				}
				attempts += 1;
				retryTimer = setTimeout(connect, executionEventsRetryDelayMs(attempts));
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			source?.close();
		};
	}, [runId, eventsUrl, isStreaming]);
}
