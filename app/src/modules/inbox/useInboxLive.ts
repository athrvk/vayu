/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inbox's live capture stream (issue #480).
 *
 * `GET /inbox/:id/live` emits one SSE event per capture, so the list does not
 * poll: a webhook arrives and the row appears. The engine allows exactly one
 * stream per inbox - each holds a pool thread for its whole life - which is why
 * this hook opens and closes with the *selected* inbox rather than one stream
 * per inbox on screen.
 *
 * New captures are merged into the same query cache `useInboxCapturesQuery`
 * fills, rather than kept in a second list beside it. Two lists would have to
 * be reconciled on every clear and refetch, and the one the detail pane read
 * would decide which of them was the truth.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { queryKeys } from "@/queries";
import type { InboxCapture, InboxCapturesResponse } from "@/types";

/** Narrow one SSE payload to a capture, or reject it. */
export function parseCaptureEvent(raw: unknown): InboxCapture | null {
	if (typeof raw !== "object" || raw === null) return null;
	const e = raw as Record<string, unknown>;
	// `id` and `method` are what the list keys and renders on; a payload
	// missing either is dropped rather than defaulted into a row claiming to be
	// a request nothing sent.
	if (typeof e.id !== "number" || typeof e.method !== "string") return null;
	if (typeof e.inboxId !== "string" || typeof e.path !== "string") return null;
	return {
		id: e.id,
		inboxId: e.inboxId,
		receivedAt: typeof e.receivedAt === "number" ? e.receivedAt : Date.now(),
		method: e.method,
		path: e.path,
		query: typeof e.query === "string" ? e.query : "",
		headers:
			typeof e.headers === "object" && e.headers !== null
				? (e.headers as Record<string, string>)
				: {},
		body: typeof e.body === "string" ? e.body : "",
		bodyBytes: typeof e.bodyBytes === "number" ? e.bodyBytes : 0,
		bodyTruncated: e.bodyTruncated === true,
		remoteAddr: typeof e.remoteAddr === "string" ? e.remoteAddr : "",
	};
}

/**
 * Prepend @p capture to a cached page, newest first.
 *
 * Idempotent on the capture id: the first fetch and the stream overlap by
 * however many captures arrived between them, and a duplicate row is a row the
 * user cannot tell from a second delivery of the same webhook.
 */
export function mergeCapture(
	cached: InboxCapturesResponse | undefined,
	capture: InboxCapture
): InboxCapturesResponse {
	const existing = cached?.data ?? [];
	if (existing.some((c) => c.id === capture.id)) {
		return cached as InboxCapturesResponse;
	}
	const total = (cached?.pagination.total ?? existing.length) + 1;
	return {
		data: [capture, ...existing],
		pagination: {
			total,
			limit: cached?.pagination.limit ?? existing.length + 1,
			offset: cached?.pagination.offset ?? 0,
			returned: existing.length + 1,
			hasMore: cached?.pagination.hasMore ?? false,
		},
	};
}

/** Reconnect attempts before the surface says so and waits to be told. */
export const INBOX_LIVE_MAX_RETRIES = 5;
/** First backoff step; each attempt doubles it, up to the cap. */
export const INBOX_LIVE_RETRY_BASE_MS = 400;
export const INBOX_LIVE_RETRY_MAX_MS = 5000;

/**
 * How long to wait before reconnect attempt @p attempt (1-based).
 *
 * The first step has to outlast the engine's dead-socket detection - the
 * previous stream's claim is held until its poll loop notices, one
 * `inboxLivePollIntervalMs` later - because a reconnect inside that window is
 * refused with a 409. The app cannot read that setting, so the backoff doubles
 * rather than guessing it: 400ms clears the 250ms default on the first attempt
 * and a raised cadence is covered within two or three. Jitter keeps several
 * watchers from retrying in lockstep.
 */
export function inboxLiveRetryDelayMs(attempt: number, random: () => number = Math.random): number {
	const step = Math.min(
		INBOX_LIVE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
		INBOX_LIVE_RETRY_MAX_MS
	);
	return Math.round(step + random() * step * 0.5);
}

/** One subscription's stream state, stamped with the subscription it belongs to. */
interface LiveStatus {
	subscription: string;
	open: boolean;
	stopped: boolean;
}

/** Not yet open and not yet given up on - what every subscription starts as. */
const FRESH: LiveStatus = { subscription: "", open: false, stopped: false };

/** What the surface renders from {@link useInboxLive}. */
export interface InboxLiveState {
	/**
	 * Whether the stream is open. A listener that is running while nothing is
	 * watching it is still capturing, and the two states are not the same - the
	 * badge tells them apart.
	 */
	watching: boolean;
	/**
	 * Set once the reconnects are spent. Captures are still being recorded; the
	 * list has simply stopped hearing about them, which is worth saying out loud
	 * rather than leaving the badge to read `Running` forever.
	 */
	stopped: boolean;
	/** Re-subscribe now, resetting the retry budget. */
	resume: () => void;
}

/**
 * Watch one inbox.
 *
 * The retry is ours rather than the browser's (issue #506). `EventSource` treats
 * any non-200 as fatal and never retries it, and a reconnect that lands inside
 * the engine's dead-socket detection window meets a `409 inbox_live_in_use` from
 * the claim the previous stream is still holding - so a single unlucky
 * disconnect used to end the stream for the life of the tab, with nothing said.
 *
 * `SSEClient` deliberately does *not* reconnect, but its reason does not apply
 * here: a run's stream would replay its whole retained ring and clobber the live
 * visuals, whereas an inbox resume is addressed by capture id and
 * {@link mergeCapture} is idempotent on it, so at worst a resume re-delivers
 * rows the list already has.
 */
export function useInboxLive(inboxId: string | null, enabled: boolean): InboxLiveState {
	const queryClient = useQueryClient();
	// Bumping this re-runs the effect, which is what a manual resume is: the
	// same subscription, from the same resume point, with a fresh budget.
	const [resumeNonce, setResumeNonce] = useState(0);
	// Which subscription the state below describes. A status left by an earlier
	// one says nothing about this one, so it is discarded while rendering rather
	// than reset by an effect - the reset would otherwise land a render late,
	// showing the previous inbox's badge on the new one.
	const subscription = `${inboxId ?? ""}:${resumeNonce}`;
	// Only the EventSource's own callbacks write this.
	const [status, setStatus] = useState<LiveStatus>(FRESH);
	const current = status.subscription === subscription ? status : FRESH;

	// Survives the effect re-running (a resume), and is discarded when the
	// inbox changes - a capture id belongs to the inbox that recorded it.
	const resumeFrom = useRef<{ inboxId: string | null; lastEventId: string }>({
		inboxId: null,
		lastEventId: "",
	});

	// The nonce alone clears the given-up state: it names a new subscription,
	// and the old one's status stops being the one rendered.
	const resume = useCallback(() => setResumeNonce((n) => n + 1), []);

	useEffect(() => {
		if (!inboxId || !enabled) {
			return;
		}
		if (resumeFrom.current.inboxId !== inboxId) {
			resumeFrom.current = { inboxId, lastEventId: "" };
		}

		let source: EventSource | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let cancelled = false;

		const connect = () => {
			// `Last-Event-ID` is a header the browser sets on its own reconnect
			// and that no API lets us set on a fresh connection, so ours travels
			// as a query parameter the engine reads on the same terms.
			const { lastEventId } = resumeFrom.current;
			const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
			source = new EventSource(
				`${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.INBOX_LIVE(inboxId)}${query}`
			);
			source.onopen = () => {
				attempts = 0;
				setStatus({ subscription, open: true, stopped: false });
			};
			source.onmessage = (event) => {
				if (event.lastEventId) {
					resumeFrom.current = { inboxId, lastEventId: event.lastEventId };
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(event.data);
				} catch {
					return; // A frame this engine wrote always parses.
				}
				const capture = parseCaptureEvent(parsed);
				if (!capture) return;
				queryClient.setQueryData<InboxCapturesResponse>(
					queryKeys.inbox.captures(inboxId),
					(cached) => mergeCapture(cached, capture)
				);
			};
			source.onerror = () => {
				const exhausted = !cancelled && attempts >= INBOX_LIVE_MAX_RETRIES;
				setStatus({ subscription, open: false, stopped: exhausted });
				// Closed rather than left to the browser: a 409 is fatal to it,
				// and a source it has already given up on holds no retry of its
				// own. Everything after this point is our reconnect.
				source?.close();
				source = null;
				if (cancelled || exhausted) return;
				attempts += 1;
				retryTimer = setTimeout(connect, inboxLiveRetryDelayMs(attempts));
			};
		};

		connect();

		return () => {
			cancelled = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			source?.close();
		};
	}, [inboxId, enabled, queryClient, subscription]);

	return {
		watching: current.open && enabled && inboxId !== null,
		stopped: current.stopped && enabled && inboxId !== null,
		resume,
	};
}
