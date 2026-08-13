/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The command context, for a surface that renders.
 *
 * What the registry cannot read from a store: which tab is active and what the
 * strip calls it, which collection that tab shows, and the dialog host the
 * caller is offering. `baseCommandContext` is the React-free version for the
 * native-menu bridge.
 *
 * The label comes from `useTabDescriptors` - the hook the tab strip itself uses
 * - so "Close 'GET /v1/orders'" in the palette and the tab it closes cannot read
 * differently. Only the active tab is passed, so this costs one descriptor, not
 * a strip's worth.
 */

import { useMemo } from "react";
import { useTabsStore } from "@/stores";
import { useCollectionsQuery } from "@/queries";
import { useTabDescriptors } from "@/components/layout/tab-descriptors";
import type { CommandContext, CommandSurfaces } from "@/lib/commands";

export function useCommandContext(surfaces?: CommandSurfaces): CommandContext {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const { data: collections = [] } = useCollectionsQuery();

	const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
	const descriptors = useTabDescriptors(activeTab ? [activeTab] : []);
	const activeTabLabel = descriptors[0]?.label ?? null;

	const activeCollection =
		activeTab?.type === "collection" && activeTab.entityId
			? (collections.find((c) => c.id === activeTab.entityId) ?? null)
			: null;

	return useMemo(
		() => ({ activeTab, activeTabLabel, activeCollection, surfaces }),
		[activeTab, activeTabLabel, activeCollection, surfaces]
	);
}
