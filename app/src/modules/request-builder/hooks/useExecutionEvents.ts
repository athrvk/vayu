/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Tail a streaming request's events (#574). `POST /execute` with `stream: true` answers
 * `202 {runId, eventsUrl}`, and the upstream's events arrive over that URL as SSE. This owns the
 * one subscription `execution-events-store` holds and writes every frame there, batched on the
 * live-refresh cadence, not one commit per frame (#1158).
 *
 * **A per-endpoint `EventSource`, not the `SSEClient` singleton**, which belongs to load and
 * scenario runs: one connection living as long as the dashboard, deliberately never reconnecting.
 * This follows the inbox capture stream (`services/inbox-watch-service.ts`, #506): `EventSource`
 * treats any non-200 as fatal, and a reconnect inside the engine's dead-socket window meets
 * `409 run_events_in_use` from the previous socket's claim, so one unlucky drop would silently end
 * the stream for the tab's life.
 *
 * The resume point is tracked, not the ring replayed: `?lastEventId=` resumes *after* the named
 * frame, so a dropped consumer re-renders nothing. Frame ids start at 0 and the store appends
 * blindly, so a replay from the start would double every row.
 */

import { useEffect, useRef } from "react";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { streamRetryDelayMs } from "@/lib/stream-backoff";
import { createThrottledBatcher } from "@/services/throttled-batcher";
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
 * The wait before reconnect @p attempt (1-based). The first step must outlast the engine's
 * stale-claim window (the previous claim holds until two keep-alive intervals pass without a
 * write), as a reconnect inside it is a 409. The app cannot read that setting, so the backoff
 * doubles rather than guess.
 */
export function executionEventsRetryDelayMs(
	attempt: number,
	random: () => number = Math.random
): number {
	return streamRetryDelayMs(
		attempt,
		{ baseMs: EXECUTION_EVENTS_RETRY_BASE_MS, maxMs: EXECUTION_EVENTS_RETRY_MAX_MS },
		random
	);
}

/** Narrow one relay `open` payload, or reject it. */
export function parseOpenFrame(raw: unknown): StreamOpen | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	// `statusCode` is what the status bar renders; a frame without one says nothing about the
	// stream, so it is dropped, not defaulted to a "0" the pane would draw as a client error.
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
 * Narrow one relayed upstream event, or reject it. `data` is the row's content and `event` its
 * label, so a frame missing either is dropped, not defaulted (a `message` row with an empty body
 * claims an event never sent). Genuinely empty `data` arrives as `""` and passes.
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
		...(typeof e.text === "string" && { text: e.text }),
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
		// An unknown reason reads as `error`, not invented: the tab says why every stream ended,
		// and "unreadable" is nearer an error than a clean close.
		reason: isEndReason(e.reason) ? e.reason : "error",
		totalEvents: typeof e.totalEvents === "number" ? e.totalEvents : null,
	};
}

/**
 * Subscribe to the stream `execution-events-store` holds. Called once, by `RequestBuilderProvider`;
 * no arguments, as the store names the subscription: one stream at a time, and starting another
 * ends it.
 */
export function useExecutionEvents(): void {
	const runId = useExecutionEventsStore((s) => s.runId);
	const eventsUrl = useExecutionEventsStore((s) => s.eventsUrl);
	const isStreaming = useExecutionEventsStore((s) => s.isStreaming);

	// Survives the effect re-running, keyed by run: a frame id belongs to the relay that issued it.
	const resumeFrom = useRef<{ runId: string | null; lastEventId: string }>({
		runId: null,
		lastEventId: "",
	});

	useEffect(() => {
		// `isStreaming` gates too: an ended stream's rows stay for the pane, and reopening the
		// relay for a finished run would replay the ring into a full list.
		if (!runId || !eventsUrl || !isStreaming) return;

		if (resumeFrom.current.runId !== runId) {
			resumeFrom.current = { runId, lastEventId: "" };
		}

		const store = useExecutionEventsStore.getState();

		/*
		 * A commit per flush window, not per frame (#1158), through
		 * `services/throttled-batcher.ts`, the mechanism `LoadTestService` and `ScenarioRunService`
		 * use on the same `liveRefreshMs` cadence, so a timing fix lands once. In the effect, not a
		 * ref: it holds one subscription's frames, like the resume point and the `EventSource`
		 * beside it.
		 */
		const batcher = createThrottledBatcher<StreamEvent>((batch) =>
			store.addEvents(runId, batch)
		);

		let source: EventSource | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let cancelled = false;
		// Set by the `complete` frame; the relay closes the socket right after, which must not read
		// as a drop.
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
			// `Last-Event-ID` is a header only the browser's own reconnect sets, with no API for a
			// fresh connection, so ours goes as a query parameter the engine reads the same way.
			const { lastEventId } = resumeFrom.current;
			const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
			source = new EventSource(`${API_ENDPOINTS.BASE_URL}${eventsUrl}${query}`);

			source.addEventListener("open", (event) => {
				// The relay's `open` *frame*, not `EventSource`'s connection event: same name,
				// different meaning; only a frame carries data, which tells them apart.
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
				if (parsed) batcher.push(parsed);
			};

			source.addEventListener("complete", (event) => {
				ended = true;
				const { reason, totalEvents } =
					event instanceof MessageEvent
						? parseCompleteFrame(payloadOf(event))
						: { reason: "error" as const, totalEvents: null };
				// Before `endStream`, and not only for the last rows: a `complete` naming no total
				// falls back to `events.length`, so a buffered tail would be missing from the count
				// too.
				batcher.flush();
				store.endStream(runId, reason, totalEvents);
				source?.close();
				source = null;
			});

			source.onerror = () => {
				// The socket closing *after* a `complete` is a normal end, not a drop.
				if (ended || cancelled) {
					source?.close();
					source = null;
					return;
				}
				source?.close();
				source = null;

				if (attempts >= EXECUTION_EVENTS_MAX_RETRIES) {
					// What arrived before the loss belongs under the notice explaining it, not
					// dropped with it.
					batcher.flush();
					// Ended, not left open: the reconnects are spent, and a pane still saying
					// "streaming" would lie. `error` is honest: the engine may still be receiving
					// events, and the stored trace will say what.
					store.setError(
						runId,
						"Couldn't reconnect to Vayu's live feed of this stream. The run's stored events are still recorded."
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
			/*
			 * Flush, not discard. Teardown is the stream ending (buffer already flushed) or this
			 * subscription being replaced, and only the store knows which run the leftovers belong
			 * to: `addEvents` drops a batch for a run it no longer holds, and `startStream` has
			 * moved it on by now. Discarding would lose up to a window of a still-held stream,
			 * which the relay will not re-deliver past the resume point.
			 */
			batcher.flush();
			if (retryTimer !== null) clearTimeout(retryTimer);
			source?.close();
		};
	}, [runId, eventsUrl, isStreaming]);
}
