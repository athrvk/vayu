/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Who holds an inbox's live capture stream (issues #480, #506, #1388, #1400).
 *
 * The stream used to be the inbox view's: `useInboxLive` opened it on mount and
 * closed it on unmount. One tab's surface is mounted at a time, so the per-inbox
 * `Notify` toggle - whose whole purpose is to speak while the user is in another
 * application - was silenced by the click that precedes leaving: switching to a
 * request tab unmounted the view, and with it the socket and the notifier.
 *
 * So the socket lives here, beside `load-test-service.ts`, which owns a run's
 * stream for the same reason: "this service runs independently of React
 * components, ensuring the SSE connection stays alive regardless of navigation".
 * The view is now one holder among others, and a stream closes when nothing
 * wants it rather than when a tab changes.
 *
 * Two kinds of holder, unioned:
 *
 * - {@link InboxWatchService.reconcile}, the standing want: every running inbox
 *   whose `Notify` toggle is on. `useInboxWatchers` computes it at the app level.
 * - {@link InboxWatchService.retain}, a view's reference: the inbox on screen is
 *   watched whether or not it notifies, because the list is what the stream
 *   fills.
 *
 * The engine allows exactly one live stream per inbox (409 `inbox_live_in_use`)
 * and each parks a pool thread for its life, so a shared socket is not an
 * optimisation here - a second one would be refused.
 */

import { API_ENDPOINTS } from "@/config/api-endpoints";
import { queryClient } from "@/lib/query-client";
import { mergeCapture } from "@/queries/inbox";
import { queryKeys } from "@/queries/keys";
import { createCaptureNotifier, type CaptureNotifier } from "@/modules/inbox/capture-notifier";
import type { Inbox, InboxCapture, InboxCapturesResponse } from "@/types";

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

/** Reconnect attempts before the surface says so and waits to be told. */
export const INBOX_LIVE_MAX_RETRIES = 5;
/** First backoff step; each attempt doubles it, up to the cap. */
export const INBOX_LIVE_RETRY_BASE_MS = 400;
export const INBOX_LIVE_RETRY_MAX_MS = 5000;

/**
 * How many inboxes may be streamed at once.
 *
 * Each stream parks one thread of the engine's API pool, whose base is
 * `max(8, hardware_concurrency - 1)` and which is elastic to four times that,
 * so eight is spending at most the base pool's own width on watchers while the
 * elastic headroom answers ordinary requests. Nothing caps the number of
 * inboxes a user may start, and `managed_listener.cpp` assumes "a handful"; the
 * bound is here so a persisted toggle map from a busy session cannot open an
 * unbounded number of sockets at startup. The inbox on screen always gets a
 * slot - see {@link InboxWatchService.wantedInboxIds}.
 */
export const MAX_INBOX_WATCH_STREAMS = 8;

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

/**
 * Ask the engine, now, whether @p inboxId still has a listener (issue #554).
 *
 * A stream ends the same way whether the connection dropped or somebody stopped
 * the inbox - from the drawer, an MCP tool or a bare curl - and only the engine
 * knows which. The list is polled at `SERVICES_POLL_INTERVAL_MS`, so left to the
 * poll a deliberate stop spends up to ten seconds looking like a live inbox
 * whose stream is flapping. Reading it here answers both halves: the surface
 * reflects the stop within the close, and the reconnect budget is kept for the
 * drops it was added for.
 *
 * Only a definite answer counts. A refetch that failed leaves the last good
 * list in the cache, which still says `running` - so a stream lost to a blip
 * retries, as it must.
 */
async function listenerIsGone(inboxId: string): Promise<boolean> {
	// `refetchType: "all"`, not the default "active": whether some other surface
	// happens to be observing the list is not what should decide whether this
	// answer is fresh.
	await queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list(), refetchType: "all" });
	const inboxes = queryClient.getQueryData<Inbox[]>(queryKeys.inbox.list());
	if (inboxes === undefined) return false;
	return inboxes.find((i) => i.inboxId === inboxId)?.running !== true;
}

/** What a surface renders from one inbox's stream. */
export interface InboxWatchState {
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
}

/** No stream, and none given up on - what an unwatched inbox reports. */
const IDLE: InboxWatchState = { watching: false, stopped: false };

/** One inbox's socket and everything that outlives its reconnects. */
interface Stream {
	inboxId: string;
	source: EventSource | null;
	notifier: CaptureNotifier;
	/** Reconnects spent since the last open. */
	attempts: number;
	retryTimer: ReturnType<typeof setTimeout> | null;
	/** Where a reconnect resumes from; a capture id belongs to one inbox. */
	lastEventId: string;
	state: InboxWatchState;
}

type StateListener = (state: InboxWatchState) => void;

class InboxWatchService {
	private streams = new Map<string, Stream>();
	/** Inboxes a mounted view is showing, by reference count. */
	private held = new Map<string, number>();
	/** Inboxes whose captures may notify, in the order they should get slots. */
	private wanted: string[] = [];
	private listeners = new Map<string, Set<StateListener>>();

	/**
	 * The standing want: every running inbox whose `Notify` toggle is on.
	 *
	 * Called with the whole set rather than one id at a time, because that is
	 * what the app-level hook knows: an inbox stopping, a toggle going off and a
	 * list arriving are all the same event to a reconciler.
	 */
	reconcile(inboxIds: readonly string[]): void {
		this.wanted = [...inboxIds];
		this.apply();
	}

	/** A view is showing @p inboxId and wants its stream open while it is. */
	retain(inboxId: string): void {
		this.held.set(inboxId, (this.held.get(inboxId) ?? 0) + 1);
		this.apply();
	}

	/** The counterpart of {@link retain}; the socket closes on the last release. */
	release(inboxId: string): void {
		const holders = (this.held.get(inboxId) ?? 0) - 1;
		if (holders > 0) this.held.set(inboxId, holders);
		else this.held.delete(inboxId);
		this.apply();
	}

	/** Watch one inbox's stream state. The listener is called with it at once. */
	subscribe(inboxId: string, listener: StateListener): () => void {
		const forInbox = this.listeners.get(inboxId) ?? new Set<StateListener>();
		forInbox.add(listener);
		this.listeners.set(inboxId, forInbox);
		listener(this.getState(inboxId));
		return () => {
			forInbox.delete(listener);
			if (forInbox.size === 0) this.listeners.delete(inboxId);
		};
	}

	getState(inboxId: string): InboxWatchState {
		return this.streams.get(inboxId)?.state ?? IDLE;
	}

	/**
	 * Re-subscribe now, from the same resume point, with a fresh budget.
	 *
	 * Immediately, without the backoff a reconnect uses: this is a user asking,
	 * and a Resume that waited would look like a control that did nothing. A
	 * reconnect landing inside the engine's dead-socket window still meets the
	 * previous claim's 409, which is what the ladder below is for - the same is
	 * true of a `Notify` toggle flipped off and straight back on, which closes
	 * and reopens through {@link apply}.
	 */
	resume(inboxId: string): void {
		const stream = this.streams.get(inboxId);
		if (!stream) {
			this.apply();
			return;
		}
		this.disconnect(stream);
		stream.attempts = 0;
		this.setState(stream, IDLE);
		this.connect(stream);
	}

	/** Drop every stream. For teardown and for a test's clean slate. */
	stopAll(): void {
		for (const stream of [...this.streams.values()]) this.close(stream);
		this.held.clear();
		this.wanted = [];
	}

	/** Which inboxes should hold a socket, best claim first. */
	private wantedInboxIds(): string[] {
		// The view's inbox first: it is the one whose captures are being read,
		// and a list that stopped filling is visible in a way a missed
		// notification is not.
		const ordered = [...this.held.keys()];
		for (const inboxId of this.wanted) {
			if (!ordered.includes(inboxId)) ordered.push(inboxId);
		}
		return ordered.slice(0, MAX_INBOX_WATCH_STREAMS);
	}

	/** Open what is wanted, close what is not. The only place either happens. */
	private apply(): void {
		const wanted = this.wantedInboxIds();
		for (const stream of [...this.streams.values()]) {
			if (!wanted.includes(stream.inboxId)) this.close(stream);
		}
		for (const inboxId of wanted) {
			if (!this.streams.has(inboxId)) this.open(inboxId);
		}
	}

	private open(inboxId: string): void {
		const stream: Stream = {
			inboxId,
			source: null,
			// One notifier per stream, so a stream that ends neither carries its
			// window into the next one nor announces its captures (#1388).
			notifier: createCaptureNotifier(inboxId),
			attempts: 0,
			retryTimer: null,
			lastEventId: "",
			state: IDLE,
		};
		this.streams.set(inboxId, stream);
		this.connect(stream);
	}

	private close(stream: Stream): void {
		this.disconnect(stream);
		stream.notifier.dispose();
		this.streams.delete(stream.inboxId);
		this.emit(stream.inboxId, IDLE);
	}

	/** Drop the socket and any pending reconnect, keeping the resume point. */
	private disconnect(stream: Stream): void {
		if (stream.retryTimer !== null) clearTimeout(stream.retryTimer);
		stream.retryTimer = null;
		stream.source?.close();
		stream.source = null;
	}

	private connect(stream: Stream): void {
		// `Last-Event-ID` is a header the browser sets on its own reconnect and
		// that no API lets us set on a fresh connection, so ours travels as a
		// query parameter the engine reads on the same terms.
		const query = stream.lastEventId
			? `?lastEventId=${encodeURIComponent(stream.lastEventId)}`
			: "";
		const source = new EventSource(
			`${API_ENDPOINTS.BASE_URL}${API_ENDPOINTS.INBOX_LIVE(stream.inboxId)}${query}`
		);
		stream.source = source;
		source.onopen = () => {
			stream.attempts = 0;
			this.setState(stream, { watching: true, stopped: false });
		};
		source.onmessage = (event) => this.receive(stream, event);
		source.onerror = () => this.recover(stream);
	}

	private receive(stream: Stream, event: MessageEvent): void {
		if (event.lastEventId) stream.lastEventId = event.lastEventId;
		let parsed: unknown;
		try {
			parsed = JSON.parse(event.data);
		} catch {
			return; // A frame this engine wrote always parses.
		}
		const capture = parseCaptureEvent(parsed);
		if (!capture) return;
		queryClient.setQueryData<InboxCapturesResponse>(
			queryKeys.inbox.captures(stream.inboxId),
			(cached) => mergeCapture(cached, capture)
		);
		// After the merge, not before: the list is what a click on the
		// notification opens, and it is written first for that reason.
		stream.notifier.record(capture);
	}

	/**
	 * The stream dropped. Retry it, unless the budget is spent or the listener
	 * is gone on purpose.
	 *
	 * The retry is ours rather than the browser's (issue #506). `EventSource`
	 * treats any non-200 as fatal and never retries it, and a reconnect that
	 * lands inside the engine's dead-socket detection window meets a
	 * `409 inbox_live_in_use` from the claim the previous stream is still
	 * holding - so a single unlucky disconnect used to end the stream for the
	 * life of the tab, with nothing said.
	 */
	private recover(stream: Stream): void {
		const exhausted = stream.attempts >= INBOX_LIVE_MAX_RETRIES;
		this.setState(stream, { watching: false, stopped: exhausted });
		// Closed rather than left to the browser: a 409 is fatal to it, and a
		// source it has already given up on holds no retry of its own.
		// Everything after this point is our reconnect.
		this.disconnect(stream);
		if (exhausted) return;
		stream.attempts += 1;
		const attempt = stream.attempts;
		void (async () => {
			// The reconnect waits on this answer rather than racing it: a retry
			// fired first is a request to re-attach to a listener the user has
			// just stopped.
			if (await listenerIsGone(stream.inboxId)) return;
			if (this.streams.get(stream.inboxId) !== stream) return;
			stream.retryTimer = setTimeout(
				() => this.connect(stream),
				inboxLiveRetryDelayMs(attempt)
			);
		})();
	}

	private setState(stream: Stream, state: InboxWatchState): void {
		stream.state = state;
		this.emit(stream.inboxId, state);
	}

	private emit(inboxId: string, state: InboxWatchState): void {
		for (const listener of this.listeners.get(inboxId) ?? []) listener(state);
	}
}

export const inboxWatchService = new InboxWatchService();
