/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Feeds the Dock/taskbar icon what only the renderer knows (issue #1364):
 * which collections the user has been in, and when the Inbox is on screen.
 *
 * Mounted once, in `App`, for the reason `useNotificationActivation` is: a
 * second mount would publish the same recents twice and double the focus
 * listener below.
 */

import { useEffect } from "react";
import { useTabsStore, type TabLocation } from "@/stores";
import { useCollectionsQuery } from "@/queries/collections";
import { osIcon } from "@/services/os-icon";
import type { Collection } from "@/types";
import type { OsIconCollection } from "@/types/electron";

/**
 * How many recent collections this side offers.
 *
 * Main applies the real cap (`OS_ICON_MAX_RECENTS`, three) when it builds the
 * menu; this only bounds the payload that crosses the IPC boundary, generously
 * enough that main's own cap is never starved by a run of duplicates or
 * deleted collections in the walk below.
 */
const OS_ICON_RECENTS_PUBLISHED = 8;

/**
 * The collections to offer the icon's menu, most recent first.
 *
 * Walks `history` from the end - the most recently visited location is last -
 * keeping collection tabs, deduped by id and resolved against the live
 * `collections` list. An id no longer in that list is a deleted collection,
 * and it is skipped rather than shown under its last-known name: a Dock menu
 * entry that opens nothing is worse than a shorter menu.
 */
export function recentCollections(
	history: readonly TabLocation[],
	collections: readonly Collection[],
	limit: number
): OsIconCollection[] {
	const seen = new Set<string>();
	const recents: OsIconCollection[] = [];
	for (let i = history.length - 1; i >= 0 && recents.length < limit; i--) {
		const location = history[i];
		if (location.type !== "collection" || location.entityId === null) continue;
		if (seen.has(location.entityId)) continue;
		seen.add(location.entityId);
		const collection = collections.find((c) => c.id === location.entityId);
		if (!collection) continue;
		recents.push({ id: collection.id, name: collection.name });
	}
	return recents;
}

export function useOsIcon(): void {
	const navHistory = useTabsStore((s) => s.navHistory);
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const { data: collections = [] } = useCollectionsQuery();

	useEffect(() => {
		osIcon.recents(recentCollections(navHistory, collections, OS_ICON_RECENTS_PUBLISHED));
	}, [navHistory, collections]);

	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const inboxOnScreen = activeTab?.type === "inbox";

	useEffect(() => {
		if (!inboxOnScreen) return;
		osIcon.inboxOpened();
		// Main counts a capture whenever the window is unfocused, including
		// while the Inbox tab is the active one - it has no way to know what the
		// renderer is showing. Without this, a user who switches away and back
		// to a window already on the Inbox would keep a badge for captures that
		// are sitting on their screen the moment they look.
		const onFocus = () => osIcon.inboxOpened();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [inboxOnScreen]);
}
