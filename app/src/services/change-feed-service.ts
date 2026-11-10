/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Who holds the engine's change feed (`GET /changes`, issue #3420).
 *
 * The open request, the tree, the environments and the Trash list are cached
 * with nothing polling them, and the request detail is `staleTime: Infinity`.
 * A write the renderer did not make itself - the stdio MCP server, `vayu-cli`,
 * a script against the engine API, a second window - used to reach none of
 * them until a reload, so Send sent a version the user had not seen. The feed
 * reports every committed write, whoever made it, and this service turns each
 * event into an invalidation (`lib/change-feed-invalidation.ts`).
 *
 * One stream for the app's life, beside `inbox-watch-service.ts` and on its
 * terms: an `EventSource` treats any non-200 as fatal and never retries it, so
 * every drop is closed here and reconnected on a backoff of our own, resuming
 * from the last id by query parameter because no API sets `Last-Event-ID` on a
 * fresh connection. Unlike an inbox stream there is no surface to say it gave
 * up, so it never does: `useChangeFeed` stops it while the engine is not
 * connected, and that is what keeps a downed engine from being asked forever.
 */

import type { QueryClient } from "@tanstack/react-query";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import {
	FeedInvalidationBatch,
	invalidationsForChange,
	parseChangeFeedChange,
} from "@/lib/change-feed-invalidation";
import { streamRetryDelayMs } from "@/lib/stream-backoff";

/** First backoff step; each attempt doubles it, up to the cap. */
export const CHANGE_FEED_RETRY_BASE_MS = 500;
/**
 * The `Retry-After` the engine sends with `503 change_feed_full` (its keep-alive
 * interval, within which a closed reader's slot is noticed). `EventSource`
 * cannot read the status or the header, so a refused stream looks like any
 * other drop; the ladder tops out at the engine's own answer instead.
 */
export const CHANGE_FEED_RETRY_MAX_MS = 15_000;

/**
 * How long to wait before reconnect attempt @p attempt (1-based), on the
 * shared stream ladder (`lib/stream-backoff.ts`).
 */
export function changeFeedRetryDelayMs(
	attempt: number,
	random: () => number = Math.random
): number {
	return streamRetryDelayMs(
		attempt,
		{ baseMs: CHANGE_FEED_RETRY_BASE_MS, maxMs: CHANGE_FEED_RETRY_MAX_MS },
		random
	);
}

export class ChangeFeedService {
	private source: EventSource | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Reconnects spent since a stream last delivered its opening frame. */
	private attempts = 0;
	/**
	 * Where a reconnect resumes from. Kept across `stop()`, so an engine that
	 * comes back replays what it published meanwhile, and an engine that was
	 * restarted answers the old process's id with a `reset`.
	 */
	private lastEventId = "";
	private batch: FeedInvalidationBatch | null = null;

	/** Open the stream, unless it is already open or reconnecting. */
	start(queryClient: QueryClient): void {
		if (this.source !== null || this.retryTimer !== null) return;
		if (this.batch?.queryClient !== queryClient)
			this.batch = new FeedInvalidationBatch(queryClient);
		this.attempts = 0;
		this.connect();
	}

	/** Close the stream and any pending reconnect. Pending invalidations still land. */
	stop(): void {
		if (this.retryTimer !== null) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.source?.close();
		this.source = null;
	}

	private connect(): void {
		this.retryTimer = null;
		// No resume point: nothing tells this stream what was written before it.
		const fresh = this.lastEventId === "";
		const query = this.lastEventId
			? `?lastEventId=${encodeURIComponent(this.lastEventId)}`
			: "";
		const source = new EventSource(`${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.CHANGES}${query}`);
		this.source = source;
		// Each listener checks it is still the current source: a closed one can
		// still deliver what it had already read.
		source.addEventListener("ready", (event) => {
			if (this.source !== source) return;
			this.opened(event as MessageEvent);
			if (fresh) this.batch?.addOpenRows();
		});
		source.addEventListener("reset", (event) => {
			if (this.source !== source) return;
			this.opened(event as MessageEvent);
			this.batch?.addReset();
		});
		source.addEventListener("change", (event) => {
			if (this.source === source) this.receive(event as MessageEvent);
		});
		source.onerror = () => {
			if (this.source === source) this.recover();
		};
	}

	/**
	 * A `ready` or `reset`: the stream is serving. On a resume the missed events
	 * follow a `ready`. A fresh subscription's `ready` follows the app's first
	 * reads, so the open tabs re-read their rows (`invalidateOpenRows`).
	 */
	private opened(event: MessageEvent): void {
		this.attempts = 0;
		if (event.lastEventId) this.lastEventId = event.lastEventId;
	}

	private receive(event: MessageEvent): void {
		if (event.lastEventId) this.lastEventId = event.lastEventId;
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return; // A frame this engine wrote always parses.
		}
		const change = parseChangeFeedChange(parsed);
		if (!change || !this.batch) return;
		const invalidation = invalidationsForChange(this.batch.queryClient, change);
		// A kind from an engine newer than this bundle: its id still moved the
		// resume point, and nothing this build caches can be stale from it.
		if (invalidation) this.batch.add(invalidation);
	}

	/** The stream dropped, or was refused: close it and reconnect on the backoff. */
	private recover(): void {
		this.source?.close();
		this.source = null;
		this.attempts += 1;
		this.retryTimer = setTimeout(() => this.connect(), changeFeedRetryDelayMs(this.attempts));
	}
}

export const changeFeedService = new ChangeFeedService();
