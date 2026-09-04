/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The inbox view's half of the live capture stream (issues #480, #1400).
 *
 * `GET /inbox/:id/live` emits one SSE event per capture, so the list does not
 * poll: a webhook arrives and the row appears. The socket, its reconnect and the
 * merge into the query cache all belong to `services/inbox-watch-service.ts` -
 * this hook holds a reference to that inbox's stream for as long as the view is
 * mounted, and renders what the service reports.
 *
 * The stream outliving this hook is the whole point: the view is mounted only
 * while the inbox tab is the active one, and a capture that arrives while the
 * user is in another tab still has to be able to notify. Releasing the reference
 * does not close the socket unless nothing else wants it.
 */

import { useCallback, useEffect, useState } from "react";
import { inboxWatchService, type InboxWatchState } from "@/services/inbox-watch-service";

/** What the surface renders from {@link useInboxLive}. */
export interface InboxLiveState extends InboxWatchState {
	/** Re-subscribe now, resetting the retry budget. */
	resume: () => void;
}

/** Not watching, and nothing given up on. */
const IDLE: InboxWatchState = { watching: false, stopped: false };

/**
 * Watch one inbox for as long as this surface is showing it.
 *
 * @param inboxId The inbox on screen, or null when there is none.
 * @param enabled Whether the engine says that inbox is running - a stopped
 *   listener has no stream to attach to.
 */
export function useInboxLive(inboxId: string | null, enabled: boolean): InboxLiveState {
	const watched = enabled ? inboxId : null;
	// Stamped with the inbox it describes. A state left by the previously
	// addressed inbox says nothing about this one, so it is discarded while
	// rendering rather than reset by an effect - the reset would otherwise land
	// a render late, showing the previous inbox's badge on the new one.
	const [reported, setReported] = useState<{ inboxId: string; state: InboxWatchState } | null>(
		null
	);
	const state = watched !== null && reported?.inboxId === watched ? reported.state : IDLE;

	useEffect(() => {
		if (!watched) return;
		// Retained before subscribing, so the first state this renders is the one
		// belonging to the stream this view asked for rather than to whatever the
		// service happened to hold a tick earlier.
		inboxWatchService.retain(watched);
		const unsubscribe = inboxWatchService.subscribe(watched, (next) =>
			setReported({ inboxId: watched, state: next })
		);
		return () => {
			unsubscribe();
			inboxWatchService.release(watched);
		};
	}, [watched]);

	const resume = useCallback(() => {
		if (watched) inboxWatchService.resume(watched);
	}, [watched]);

	return { watching: state.watching, stopped: state.stopped, resume };
}
