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

import { useEffect, useState } from "react";
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

/**
 * Watch one inbox. Returns whether the stream is currently open, which is what
 * the surface badges - a listener that is running while nothing is watching it
 * is still capturing, and the two states are not the same.
 */
export function useInboxLive(inboxId: string | null, enabled: boolean): boolean {
	const queryClient = useQueryClient();
	// Only the EventSource's own callbacks write this; whether a stream should
	// exist at all is derived below, so switching inboxes needs no setState of
	// its own.
	const [streamOpen, setStreamOpen] = useState(false);

	useEffect(() => {
		if (!inboxId || !enabled) {
			return;
		}

		const source = new EventSource(
			`${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.INBOX_LIVE(inboxId)}`
		);
		source.onopen = () => setStreamOpen(true);
		source.onmessage = (event) => {
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
			// EventSource reconnects on its own with Last-Event-ID, which the
			// engine honours - so this reports the gap rather than tearing the
			// stream down. A closed source is terminal and stays reported.
			setStreamOpen(false);
		};

		return () => source.close();
	}, [inboxId, enabled, queryClient]);

	return streamOpen && enabled && inboxId !== null;
}
