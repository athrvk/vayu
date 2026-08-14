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
 * It holds **one** stream. A design-mode Send replaces whatever the previous
 * one left, exactly as sending again replaces the response: two streams are not
 * a state the builder can reach, since the second Send is what ends the first.
 *
 * It also holds the *request* the stream belongs to, not only the run. The
 * builder is one provider reused across request tabs, so "are these rows mine?"
 * is a question about the request on screen, and a run id alone cannot answer
 * it.
 *
 * Once the run reaches its terminal status the **stored** trace is the complete
 * record and the tab reads that instead (`restore-response.ts`) - what lives
 * here is only ever what has arrived so far, bounded by the engine's retained
 * ring rather than by anything this side.
 */

import { create } from "zustand";
import type { StreamEndReason, StreamEvent, StreamOpen } from "@/types";

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

	/** Begin a stream: clears any previous one's rows, then starts streaming. */
	startStream: (params: { requestId: string | null; runId: string; eventsUrl: string }) => void;
	noteOpen: (runId: string, open: StreamOpen) => void;
	addEvent: (runId: string, event: StreamEvent) => void;
	endStream: (runId: string, reason: StreamEndReason, totalEvents: number | null) => void;
	setError: (runId: string, error: string | null) => void;
	/** Forget the stream entirely - used when the response it fed is replaced. */
	clear: () => void;
}

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
} satisfies Omit<
	ExecutionEventsState,
	"startStream" | "noteOpen" | "addEvent" | "endStream" | "setError" | "clear"
>;

export const useExecutionEventsStore = create<ExecutionEventsState>((set) => ({
	...EMPTY,

	startStream: ({ requestId, runId, eventsUrl }) =>
		set({ ...EMPTY, requestId, runId, eventsUrl, isStreaming: true }),

	/*
	 * Every writer below is addressed to a run, and a write for a run this store
	 * is not holding is dropped.
	 *
	 * Not defensive tidiness: the relay replays its retained ring on connect, so
	 * a frame from a stream that has already been replaced can still arrive on a
	 * socket that has not finished closing. It belongs to nothing on screen.
	 */
	noteOpen: (runId, open) => set((s) => (s.runId === runId ? { open } : s)),

	addEvent: (runId, event) =>
		set((s) => (s.runId === runId ? { events: [...s.events, event] } : s)),

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

	clear: () => set({ ...EMPTY }),
}));
