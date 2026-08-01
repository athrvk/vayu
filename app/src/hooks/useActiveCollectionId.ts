/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useActiveCollectionId Hook
 *
 * The collection whose variables are in scope for whatever the user is looking
 * at - a request tab's own collection, or a collection tab itself.
 *
 * This exists for the Monaco completion providers. They are registered once per
 * *language* in `App`, so unlike `VariableInput` they have no request builder
 * context to take a `collectionId` from - and `useVariableResolver` includes
 * collection-scope variables only when it is given one (collection scope is
 * explicit only; see the note in that hook). Without this they offered globals,
 * the active environment and the dynamic table, and left the collection's own
 * names out of every editor.
 *
 * The active tab is the right source: it is what the frontmost editor belongs
 * to, and it is what `ContextBar` already reads for the same question.
 */

import { useTabsStore } from "@/stores";
import { useRequestQuery } from "@/queries";

export function useActiveCollectionId(): string | undefined {
	const { openTabs, activeTabId } = useTabsStore();
	const activeTab = openTabs.find((t) => t.id === activeTabId);

	// A collection tab needs no lookup - the Collection Detail script panels are
	// Monaco editors whose scope is the collection on screen.
	const collectionTabId = activeTab?.type === "collection" ? activeTab.entityId : null;

	const { data: request } = useRequestQuery(
		activeTab?.type === "request" ? activeTab.entityId : null
	);

	return collectionTabId ?? request?.collectionId ?? undefined;
}
