/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keep a live stream on every inbox that may notify (issue #1400).
 *
 * Mounted in `App.tsx` rather than in the inbox view, for the reason
 * `useHostSleepRecorder` is: the event this exists for arrives while the user is
 * somewhere else. An inbox tab is mounted only while it is the active tab, so a
 * stream it owned went away the moment the user clicked a request tab on their
 * way out of the window - which is precisely when the `Notify` toggle was meant
 * to speak. `inbox-watch-service` owns the sockets; this is the standing answer
 * to which inboxes it should hold, recomputed as the list and the toggles
 * change.
 *
 * The inbox list is observed here only while at least one inbox may notify. It
 * polls every `SERVICES_POLL_INTERVAL_MS` and a root observer that nobody reads
 * is what #1150 removed, so the app pays for this list when the feature is on
 * and not otherwise. The pruning of dead ids is bound to the same read: an id
 * belongs to the engine process that minted it, and this is where the answer the
 * engine gave arrives.
 */

import { useEffect, useMemo } from "react";
import { useInboxesQuery } from "@/queries";
import { useInboxNotifyStore } from "@/stores";
import { inboxWatchService } from "@/services/inbox-watch-service";

export function useInboxWatchers(): void {
	const enabled = useInboxNotifyStore((s) => s.enabled);
	const retainInboxes = useInboxNotifyStore((s) => s.retainInboxes);
	const anyEnabled = Object.keys(enabled).length > 0;
	const { data: inboxes, isSuccess } = useInboxesQuery({ enabled: anyEnabled });

	// Pruned against an answer the engine actually gave: a failed or unsettled
	// read leaves the map alone, because "no inboxes" and "could not ask" are
	// not the same list (#1388). Moved here from the inbox view, which pruned
	// only while its tab was open (#1400).
	useEffect(() => {
		if (!isSuccess || !inboxes) return;
		retainInboxes(inboxes.map((i) => i.inboxId));
	}, [isSuccess, inboxes, retainInboxes]);

	// Ordered by port, the one stable key an inbox record carries: which inboxes
	// keep their stream when there are more of them than slots must not depend
	// on the engine's map order, which is not stable across polls.
	const watched = useMemo(
		() =>
			(inboxes ?? [])
				.filter((inbox) => inbox.running && enabled[inbox.inboxId] === true)
				.sort((a, b) => a.port - b.port)
				.map((inbox) => inbox.inboxId),
		[inboxes, enabled]
	);
	// The set's contents, not its identity: every poll answers with a new array,
	// and re-running the reconciler on each of them would be a no-op it has to
	// prove rather than one it never starts.
	const watchedKey = watched.join("\n");

	useEffect(() => {
		inboxWatchService.reconcile(watchedKey === "" ? [] : watchedKey.split("\n"));
	}, [watchedKey]);
}
