/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which inboxes are not hearing their captures, for the drawer (issue #1412).
 *
 * One subscription for the whole list rather than `inboxWatchService.subscribe`
 * per row: the drawer renders a row per inbox, and what it needs is one answer
 * about all of them - including the inboxes with no stream at all, which a
 * per-inbox subscription has nothing to report about.
 *
 * `useSyncExternalStore` rather than an effect and a `useState`: the service is
 * the store, and a snapshot read during render is what keeps a row from drawing
 * one paint of stale state after a stream gives up.
 */

import { useSyncExternalStore } from "react";
import { inboxWatchService, type InboxWatchSummary } from "@/services/inbox-watch-service";

const subscribe = (listener: () => void) => inboxWatchService.subscribeSummary(listener);
const snapshot = () => inboxWatchService.getSummary();

export function useInboxWatchSummary(): InboxWatchSummary {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
