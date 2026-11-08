/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Execution Events Store (the live half of a streaming request, issue #574)
 *
 * `useExecutionEvents` pushes each relayed frame in here and the response
 * pane's Events tab reads it, so the rows survive switching to another request
 * tab and back - the same split, for the same reason, as `LoadTestService` and
 * `dashboard-store`, and `ScenarioRunService` and `scenario-run-store`.
 *
 * It holds **one** stream. A stream Send replaces whatever the previous one
 * left, exactly as sending again replaces the response: two live feeds are not
 * a state the builder can reach, since the second Send is what closes the
 * first's. It closes the feed, not the run: the engine's consumer worker keeps
 * going until the stream's own end rule, so a feed taken over from another
 * request is remembered in `replacedFeeds` for that request's pane to say so,
 * once the new stream has actually started (#3352).
 *
 * It also holds the *request* the stream belongs to, not only the run. The
 * builder is one provider reused across request tabs, so "are these rows mine?"
 * is a question about the request on screen, and a run id alone cannot answer
 * it.
 *
 * And it holds what the stream's finalisation needs, for the held stream and
 * every replaced feed alike: the Send snapshot, the left-out elements and the
 * claim that keeps each run to one finalisation (#3382). Not provider refs:
 * `Shell.tsx` unmounts the builder on every tab that is not a request, and a
 * remount must neither finalize an ended run again nor drop a displaced run's
 * snapshot.
 *
 * Once the run reaches its terminal status the **stored** trace is the complete
 * record and the tab reads that instead (`restore-response.ts`) - what lives
 * here is only ever what has arrived so far.
 *
 * **What bounds that is the stream cap, not the retained ring** (issue #1158).
 * The ring - `sseMaxRetainedEvents`, 2,000 by default - is what a *reconnect*
 * replays; a connected client is replayed the ring and then tails to the end of
 * the stream, so what accumulates here is bounded by `sseMaxStreamEvents`
 * instead: 100,000 events by default, 10,000,000 at the ceiling, or the
 * duration cap, whichever the stream reaches first. Which is why the Events tab
 * windows this list rather than assuming it stays short.
 *
 * Rows arrive **in batches**, on the same `liveRefreshMs` cadence the load and
 * scenario dashboards commit on - see `addEvents`.
 */

import { create } from "zustand";
import type { LeftOutElement } from "@/lib/elements";
import type { ExampleSentRequest, StreamEndReason, StreamEvent, StreamOpen } from "@/types";

/** What a stream's Send knew that its stored run cannot say. */
interface SendSnapshot {
	/** The request as sent, for save-as-example (#1763); null for an unsaved one. */
	sent: ExampleSentRequest | null;
	/** The draft elements the Send left out of its payload (#3066). */
	leftOut: LeftOutElement[];
}

/** A run whose live feed was dropped for another request's stream. */
interface DisplacedFeed extends SendSnapshot {
	requestId: string;
	runId: string;
}

/** A run another request's stream took the live feed of, still going at the engine. */
export interface ReplacedFeed extends SendSnapshot {
	runId: string;
	/** Claimed by its finalisation: the report is being fetched or has landed. */
	finalized: boolean;
}

/** A run handed to its finalisation, with everything it needs to land. */
export interface FinalizationClaim extends SendSnapshot {
	/** The request that streamed it, which is where its response lands. */
	requestId: string;
	runId: string;
	/** `requestId`'s send count at the claim; a newer send means it was overtaken. */
	sends: number;
}

interface ExecutionEventsState {
	/** The request whose Send started this stream, or null when none has. */
	requestId: string | null;
	/** The run the engine created for it. Also what a Stop names. */
	runId: string | null;
	/** Engine-relative events URL, exactly as the execute answer gave it. */
	eventsUrl: string | null;
	/** What the stream connected to, from the relay's `open` frame. */
	open: StreamOpen | null;
	/** Events received so far, oldest first. */
	events: StreamEvent[];
	/**
	 * Every event the engine has seen, which is what the `complete` frame
	 * reports. Only ever set from that frame: while the stream runs, the
	 * arrived-so-far count is `events.length` and pretending otherwise would
	 * report a total nothing had counted.
	 */
	totalEvents: number | null;
	/** True from the send until the stream terminates, however it terminates. */
	isStreaming: boolean;
	/** Why it ended, once it has. Null while it is still open. */
	endReason: StreamEndReason | null;
	/** A transport failure on the relay; cleared by the next `startStream`. */
	error: string | null;
	/**
	 * The draft elements this stream's Send left out of its payload (#3066). The
	 * stream's response is built twice - the placeholder from the `open` frame,
	 * then the stored run's - and neither carries what the app composed, so both
	 * read it here.
	 */
	leftOut: LeftOutElement[];
	/** This stream's Send snapshot (#1763), attached to its stored response. */
	sent: ExampleSentRequest | null;
	/** Claimed by this stream's finalisation: the report is being fetched or has landed. */
	finalized: boolean;
	/**
	 * Requests whose live stream another request's Send took over, each mapped
	 * to the run that kept going at the engine. Outlives the stream fields: it
	 * describes feeds this store no longer holds.
	 */
	replacedFeeds: Readonly<Record<string, ReplacedFeed>>;
	/**
	 * Sends begun per request, from `beginSend`. A finalisation compares it with
	 * its claim's count, so a newer send of the same request wins over a late
	 * report.
	 */
	sendCounts: Readonly<Record<string, number>>;

	/**
	 * A live stream another request's Send emptied the feed of, held until that
	 * Send's stream starts: `startStream` moves it into `replacedFeeds`. A send
	 * that never opens a stream therefore takes nothing over, and the entry
	 * waits for whichever stream does start next.
	 */
	displaced: DisplacedFeed | null;

	/**
	 * Empty the feed for a stream `requestId` is about to start. A live stream
	 * of a different request becomes `displaced`; `startStream` records it.
	 */
	handOver: (requestId: string | null) => void;
	/**
	 * A Send of `requestId` began, streaming or not. It supersedes the request's
	 * `replacedFeeds` entry, and counts against any finalisation of its earlier
	 * run still in flight.
	 */
	beginSend: (requestId: string) => void;
	/**
	 * Begin a stream: clears any previous one's rows, then starts streaming, and
	 * records the `displaced` feed unless this request is the one it belonged to.
	 */
	startStream: (params: {
		requestId: string | null;
		runId: string;
		eventsUrl: string;
		leftOut?: LeftOutElement[];
		sent?: ExampleSentRequest;
	}) => void;
	/**
	 * Hand `runId` to its finalisation, once: the held stream once it has ended,
	 * or a replaced feed the caller has seen reach a terminal status. Null when
	 * the store does not hold that run or it is already claimed.
	 */
	claimFinalization: (runId: string) => FinalizationClaim | null;
	/** Give a claim back after its report could not be fetched, so a later one retries. */
	releaseFinalization: (runId: string) => void;
	noteOpen: (runId: string, open: StreamOpen) => void;
	/** Append what one flush window collected, oldest first. */
	addEvents: (runId: string, events: StreamEvent[]) => void;
	endStream: (runId: string, reason: StreamEndReason, totalEvents: number | null) => void;
	setError: (runId: string, error: string | null) => void;
	/** Forget everything, `replacedFeeds`, `displaced` and `sendCounts` included. */
	clear: () => void;
}

/** The fields one stream owns; `replacedFeeds` and the actions are not among them. */
type StreamFields = Omit<
	ExecutionEventsState,
	| "replacedFeeds"
	| "sendCounts"
	| "displaced"
	| "handOver"
	| "beginSend"
	| "startStream"
	| "claimFinalization"
	| "releaseFinalization"
	| "noteOpen"
	| "addEvents"
	| "endStream"
	| "setError"
	| "clear"
>;

const EMPTY = {
	requestId: null,
	runId: null,
	eventsUrl: null,
	open: null,
	events: [],
	totalEvents: null,
	isStreaming: false,
	endReason: null,
	error: null,
	leftOut: [],
	sent: null,
	finalized: false,
} satisfies StreamFields;

/** The feed to hold once the stream in `s` gives way to one `nextRequestId` starts. */
function displacedByHandOver(
	s: ExecutionEventsState,
	nextRequestId: string | null
): DisplacedFeed | null {
	// An ended stream's run is already stored, and a request's own re-send is
	// not another request taking over. What was already waiting stays: the
	// send that displaced it may have failed to open.
	if (!s.isStreaming || !s.requestId || !s.runId || s.requestId === nextRequestId) {
		return s.displaced;
	}
	// The snapshot travels with the run: its finalisation is still owed.
	return { requestId: s.requestId, runId: s.runId, sent: s.sent, leftOut: s.leftOut };
}

/** `replacedFeeds` once a stream for `requestId` has started over `s.displaced`. */
function feedsAfterStart(
	s: ExecutionEventsState,
	requestId: string | null
): ExecutionEventsState["replacedFeeds"] {
	if (!s.displaced || s.displaced.requestId === requestId) return s.replacedFeeds;
	const { requestId: owner, runId, sent, leftOut } = s.displaced;
	return { ...s.replacedFeeds, [owner]: { runId, sent, leftOut, finalized: false } };
}

/** The request whose replaced feed is `runId`, if one is. */
function replacedOwnerOf(s: ExecutionEventsState, runId: string): string | null {
	const entry = Object.entries(s.replacedFeeds).find(([, feed]) => feed.runId === runId);
	return entry ? entry[0] : null;
}

/** What `runId`'s finalisation needs, if the store holds it unclaimed and ready. */
function claimableRun(
	s: ExecutionEventsState,
	runId: string
): Omit<FinalizationClaim, "sends"> | null {
	if (s.runId === runId) {
		// A live stream is never finalized; its `complete` frame comes first.
		if (!s.requestId || !s.endReason || s.finalized) return null;
		return { requestId: s.requestId, runId, sent: s.sent, leftOut: s.leftOut };
	}
	const owner = replacedOwnerOf(s, runId);
	const feed = owner ? s.replacedFeeds[owner] : undefined;
	if (!owner || !feed || feed.finalized) return null;
	return { requestId: owner, runId, sent: feed.sent, leftOut: feed.leftOut };
}

/** The state with `runId`'s finalisation claim set or given back, wherever it is held. */
function withFinalized(
	s: ExecutionEventsState,
	runId: string,
	finalized: boolean
): Partial<ExecutionEventsState> {
	if (s.runId === runId) return { finalized };
	const owner = replacedOwnerOf(s, runId);
	if (!owner) return s;
	const feed = { ...s.replacedFeeds[owner], finalized };
	return { replacedFeeds: { ...s.replacedFeeds, [owner]: feed } };
}

export const useExecutionEventsStore = create<ExecutionEventsState>((set, get) => ({
	...EMPTY,
	replacedFeeds: {},
	sendCounts: {},
	displaced: null,

	handOver: (requestId) =>
		set((s) => ({ ...EMPTY, displaced: displacedByHandOver(s, requestId) })),

	beginSend: (requestId) =>
		set((s) => {
			const sendCounts = { ...s.sendCounts, [requestId]: (s.sendCounts[requestId] ?? 0) + 1 };
			if (!(requestId in s.replacedFeeds)) return { sendCounts };
			const { [requestId]: _superseded, ...replacedFeeds } = s.replacedFeeds;
			return { replacedFeeds, sendCounts };
		}),

	startStream: ({ requestId, runId, eventsUrl, leftOut = [], sent }) =>
		set((s) => ({
			...EMPTY,
			requestId,
			runId,
			eventsUrl,
			leftOut,
			sent: sent ?? null,
			isStreaming: true,
			displaced: null,
			replacedFeeds: feedsAfterStart(s, requestId),
		})),

	/*
	 * Check and set in one call, read through `get()` rather than inside `set`,
	 * because the caller needs the answer: a StrictMode double effect or a
	 * remounted builder asks again, and only the first ask may fetch.
	 */
	claimFinalization: (runId) => {
		const s = get();
		const run = claimableRun(s, runId);
		if (!run) return null;
		set(withFinalized(s, runId, true));
		return { ...run, sends: s.sendCounts[run.requestId] ?? 0 };
	},

	releaseFinalization: (runId) => set((s) => withFinalized(s, runId, false)),

	/*
	 * Every writer below is addressed to a run, and a write for a run this store
	 * is not holding is dropped.
	 *
	 * Not defensive tidiness: the relay replays its retained ring on connect, so
	 * a frame from a stream that has already been replaced can still arrive on a
	 * socket that has not finished closing. It belongs to nothing on screen.
	 */
	noteOpen: (runId, open) => set((s) => (s.runId === runId ? { open } : s)),

	/*
	 * One copy and one notify per *batch* (issue #1158). A frame used to cost a
	 * full copy of the list on its own, so a stream running at a few hundred
	 * events a second spent a renderer core on spread-copies and re-renders for
	 * as long as it ran. The batch is `useExecutionEvents`', collected by
	 * `services/throttled-batcher.ts` - never empty, per that helper's contract.
	 */
	addEvents: (runId, events) =>
		set((s) => (s.runId === runId ? { events: [...s.events, ...events] } : s)),

	endStream: (runId, reason, totalEvents) =>
		set((s) =>
			s.runId === runId
				? {
						isStreaming: false,
						endReason: reason,
						// The frame's own count when it carried one; otherwise what
						// actually arrived. Never left null once a stream has ended -
						// the tab's truncation disclosure compares the two.
						totalEvents: totalEvents ?? s.events.length,
					}
				: s
		),

	setError: (runId, error) => set((s) => (s.runId === runId ? { error } : s)),

	clear: () => set({ ...EMPTY, replacedFeeds: {}, sendCounts: {}, displaced: null }),
}));
