/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which inboxes are not hearing their captures, for the drawer (#1412). One subscription for the
 * whole list, not `inboxWatchService.subscribe` per row: the drawer needs one answer about all
 * inboxes, including those with no stream at all, which a per-inbox subscription has nothing to
 * report about.
 *
 * `useSyncExternalStore`, not an effect and a `useState`: the service is the store, and a snapshot
 * read during render keeps a row from painting one frame of stale state after a stream gives up.
 */

import { useSyncExternalStore } from "react";
import { inboxWatchService, type InboxWatchSummary } from "@/services/inbox-watch-service";

const subscribe = (listener: () => void) => inboxWatchService.subscribeSummary(listener);
const snapshot = () => inboxWatchService.getSummary();

export function useInboxWatchSummary(): InboxWatchSummary {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
