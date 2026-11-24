/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a tab's right-click menu offers (#1360), beside `TabStrip` for `tab-descriptors.ts`'s
 * reason: what a tab is called and what it can do are answers this strip gives that more than one
 * surface eventually wants.
 *
 * **Every close here is a store action, never a loop in this file.** "Close others" and "Close to
 * the right" each remove a set, which the store closes in one publication with one recorded visit
 * (`tabs-store.ts`); a loop of `closeTab` calls would walk Back through tabs the user never opened.
 *
 * **There is no Duplicate here, and that is settled** (#1360 asked for one, #1389 decided against
 * it). "A second tab on the same request" is refused by the store by construction: `openTab`
 * dedupes by entity, `sameLocation` finds a tab by the place it shows and `closeTabsForEntities`
 * closes by entity, so two tabs on one request would make all three ambiguous. Duplicating the
 * *request* is another action under the same word, already one click away on that request's row
 * (`useTreeCrud`'s `handleDuplicateRequest`); this menu is about tabs, so it grows no second route.
 * Nothing is pending behind this paragraph.
 */

import { X, XCircle, ChevronsRight, CheckCheck, Copy } from "lucide-react";
import { useTabsStore, type Tab } from "@/stores";
import { useCopy } from "@/hooks/useCopy";
import type { RowAction } from "@/components/shared";
import type { TabDescriptor } from "./tab-descriptors";

export function useTabActions(tab: Tab, descriptor: TabDescriptor): RowAction[] {
	const openTabs = useTabsStore((s) => s.openTabs);
	const closeTab = useTabsStore((s) => s.closeTab);
	const closeOtherTabs = useTabsStore((s) => s.closeOtherTabs);
	const closeTabsToRight = useTabsStore((s) => s.closeTabsToRight);
	const closeSavedTabs = useTabsStore((s) => s.closeSavedTabs);
	const { copy } = useCopy();

	const index = openTabs.findIndex((t) => t.id === tab.id);
	const isLast = index === openTabs.length - 1;

	return [
		{ label: "Close", icon: X, onSelect: () => closeTab(tab.id) },
		{
			label: "Close others",
			icon: XCircle,
			onSelect: () => closeOtherTabs(tab.id),
			// With one tab open it would do nothing; disabled says so rather than offering an inert
			// item.
			disabled: openTabs.length < 2,
		},
		{
			label: "Close to the right",
			icon: ChevronsRight,
			onSelect: () => closeTabsToRight(tab.id),
			disabled: isLast,
		},
		{
			label: "Close saved",
			icon: CheckCheck,
			onSelect: closeSavedTabs,
		},
		// Request tabs only, once the request has loaded: the path is the collection chain the
		// breadcrumb shows, held by the descriptor.
		...(descriptor.path
			? [
					{
						label: "Copy path",
						icon: Copy,
						onSelect: () => void copy(descriptor.path ?? "", "Path"),
					},
				]
			: []),
		// Every tab that names an entity, once that entity has loaded (#2047).
		...(descriptor.agentReference
			? [
					{
						label: "Copy for agent",
						icon: Copy,
						hint: descriptor.agentReference,
						onSelect: () => void copy(descriptor.agentReference ?? "", "Reference"),
					},
				]
			: []),
	];
}
