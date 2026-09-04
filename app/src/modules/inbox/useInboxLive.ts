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

import { useCallback, useEffect, useSyncExternalStore } from "react";
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

	// The reference, which is a want rather than a read: the service keeps this
	// inbox's socket open while the view is mounted, whether or not anything is
	// rendering its state.
	useEffect(() => {
		if (!watched) return;
		inboxWatchService.retain(watched);
		return () => inboxWatchService.release(watched);
	}, [watched]);

	// `useSyncExternalStore` rather than state-plus-effect, for the reason
	// `usePrefersReducedMotion` gives: the service is the source of truth, and
	// the effect version renders one frame of `IDLE` before it catches up. On a
	// tab reopened over a stream the service is already holding - the case this
	// issue is about - that frame is the badge reading `Running` and then
	// flicking to `Live`.
	const subscribe = useCallback(
		(onChange: () => void) =>
			watched ? inboxWatchService.subscribe(watched, onChange) : () => {},
		[watched]
	);
	const getSnapshot = useCallback(
		() => (watched ? inboxWatchService.getState(watched) : IDLE),
		[watched]
	);
	const state = useSyncExternalStore(subscribe, getSnapshot);

	const resume = useCallback(() => {
		if (watched) inboxWatchService.resume(watched);
	}, [watched]);

	return { watching: state.watching, stopped: state.stopped, resume };
}
