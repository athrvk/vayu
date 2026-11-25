/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collection whose variables are in scope for what the user is looking at: a request tab's own
 * collection, or a collection tab itself.
 *
 * For the Monaco completion providers. Registered once per *language* in `App`, they have no
 * request builder context to take a `collectionId` from (unlike `VariableInput`), and
 * `useVariableResolver` includes collection-scope variables only when given one (collection scope
 * is explicit only; see that hook). Without this every editor would leave the collection's own
 * names out.
 *
 * The active tab is the right source: the frontmost editor belongs to it, and `ContextBar` reads it
 * for the same question.
 */

import { useTabsStore } from "@/stores";
import { useRequestQuery } from "@/queries";

export function useActiveCollectionId(): string | undefined {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	// A collection tab needs no lookup - the Collection Detail script panels are
	// Monaco editors whose scope is the collection on screen.
	const collectionTabId = activeTab?.type === "collection" ? activeTab.entityId : null;

	const { data: request } = useRequestQuery(
		activeTab?.type === "request" ? activeTab.entityId : null
	);

	return collectionTabId ?? request?.collectionId ?? undefined;
}
