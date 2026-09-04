/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a tab's right-click menu offers (#1360).
 *
 * Beside `TabStrip` rather than inside it, for the reason `tab-descriptors.ts`
 * is: what a tab is called and what a tab can do are both answers this strip
 * gives, and both are wanted by more than one surface eventually.
 *
 * **Every close here is a store action, never a loop in this file.** Close
 * Others and Close to the Right each remove a set, and the store closes a set
 * in one publication with one recorded visit (`tabs-store.ts`); a loop of
 * `closeTab` calls would walk Back through tabs the user never opened.
 *
 * **There is no Duplicate here, and that is settled** (#1360 asked for one,
 * #1389 decided against it). The Duplicate it asked for was "a second tab on
 * the same request", which the store refuses by construction: `openTab` dedupes
 * by entity, `sameLocation` finds a tab by the place it shows, and
 * `closeTabsForEntities` closes by entity - two tabs on one request would make
 * all three ambiguous. Duplicating the *request* is a different action under
 * the same word, and it already exists one click away on that request's own row
 * (`useTreeCrud`'s `handleDuplicateRequest`); this menu is about tabs, so it
 * does not grow a second route to it. Nothing is pending behind this paragraph.
 */

import { X, XCircle, ChevronsRight, CheckCheck, Copy } from "lucide-react";
import { useTabsStore, type Tab } from "@/stores";
import { useCopy } from "@/hooks/useCopy";
import type { RowAction } from "@/components/shared";
import type { TabDescriptor } from "./tab-descriptors";

export function useTabActions(tab: Tab, descriptor: TabDescriptor): RowAction[] {
	const { openTabs, closeTab, closeOtherTabs, closeTabsToRight, closeSavedTabs } = useTabsStore();
	const copy = useCopy();

	const index = openTabs.findIndex((t) => t.id === tab.id);
	const isLast = index === openTabs.length - 1;

	return [
		{ label: "Close", icon: X, onSelect: () => closeTab(tab.id) },
		{
			label: "Close Others",
			icon: XCircle,
			onSelect: () => closeOtherTabs(tab.id),
			// Offered but inert with one tab open would be a menu item that does
			// nothing; disabled says which it is.
			disabled: openTabs.length < 2,
		},
		{
			label: "Close to the Right",
			icon: ChevronsRight,
			onSelect: () => closeTabsToRight(tab.id),
			disabled: isLast,
		},
		{
			label: "Close Saved",
			icon: CheckCheck,
			onSelect: closeSavedTabs,
		},
		// Request tabs only, and only once the request has loaded - the path is
		// the collection chain the breadcrumb shows, which the descriptor holds.
		...(descriptor.path
			? [
					{
						label: "Copy Path",
						icon: Copy,
						onSelect: () => void copy(descriptor.path ?? "", "Path"),
					},
				]
			: []),
	];
}
