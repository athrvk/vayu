/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's own surfaces - drawer views and the tabs that are one of a kind.
 *
 * Two mechanisms behind one group, because the user is not asked to know the
 * difference: Collections/History/Variables/Settings switch the drawer
 * (`activateDrawerView`, the same call the Dock's buttons make), while
 * Variables/Settings/Inbox are singleton *tabs*. Variables and Settings are
 * both - the drawer holds the tree, the tab holds the editor - so their entry
 * does what the Dock and the tree together do: open the tab and point the
 * drawer at it.
 *
 * `activateDrawerView` *toggles* when the drawer is already on that view, which
 * is right for a button pressed twice and wrong for a search result: picking
 * "History" from the palette must show History, never hide it. So the entries
 * here set the view explicitly instead.
 */

import { Braces, Clock, Folder, Inbox, Settings } from "lucide-react";
import { useLayoutStore, useTabsStore, type DrawerView, type TabType } from "@/stores";
import type { PaletteItem } from "../types";

interface ViewEntry {
	title: string;
	keywords: string[];
	icon: PaletteItem["icon"];
	/** The drawer view to reveal, when this surface has one. */
	drawerView?: DrawerView;
	/** The singleton tab to open, when this surface has one. */
	tabType?: Extract<TabType, "variables" | "settings" | "inbox">;
}

/**
 * Fixed order, matching the Dock's switchers left to right so the two lists do
 * not disagree about what the app is made of.
 */
const VIEWS: ViewEntry[] = [
	{
		title: "Collections",
		keywords: ["requests", "tree", "sidebar"],
		icon: Folder,
		drawerView: "collections",
	},
	{ title: "History", keywords: ["runs", "past", "results"], icon: Clock, drawerView: "history" },
	{
		title: "Variables",
		keywords: ["environment", "globals", "{{", "substitution"],
		icon: Braces,
		drawerView: "variables",
		tabType: "variables",
	},
	{
		title: "Settings",
		keywords: ["preferences", "options", "config"],
		icon: Settings,
		drawerView: "settings",
		tabType: "settings",
	},
	// No drawer view of its own: an inbox is engine state, not a stored record,
	// so the tab is the whole surface (see the Launcher tile's note).
	{ title: "Inbox", keywords: ["webhook", "receive", "callback"], icon: Inbox, tabType: "inbox" },
];

export function useViewItems(): PaletteItem[] {
	const openTab = useTabsStore((s) => s.openTab);
	const setDrawerOpen = useLayoutStore((s) => s.setDrawerOpen);
	const setDrawerView = useLayoutStore((s) => s.setDrawerView);

	return VIEWS.map((view) => ({
		id: `view:${view.title.toLowerCase()}`,
		kind: "view" as const,
		title: view.title,
		keywords: view.keywords,
		icon: view.icon,
		perform: () => {
			if (view.drawerView) {
				setDrawerOpen(true);
				setDrawerView(view.drawerView);
			}
			if (view.tabType) openTab({ type: view.tabType, entityId: null });
		},
	}));
}
