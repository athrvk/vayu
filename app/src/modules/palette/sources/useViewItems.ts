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
 * difference: Collections/History/Variables/Services/Trash/Settings switch the
 * drawer (`activateDrawerView`, the same call the Dock's buttons make), while
 * Variables/Settings/Inbox are singleton *tabs*. Variables and Settings are
 * both - the drawer holds the tree, the tab holds the editor - so their entry
 * does what the Dock and the tree together do: open the tab and point the
 * drawer at it.
 *
 * `activateDrawerView` *toggles* when the drawer is already on that view, which
 * is right for a button pressed twice and wrong for a search result: picking
 * "History" from the palette must show History, never hide it. So the entries
 * here reveal it instead (`revealDrawerView`, the store's non-toggling half).
 *
 * Names, marks and order for the six come from `constants/drawer-views.ts`, the
 * list the Dock reads. Restating them here is what let Collections carry
 * `FolderOpen` in the Dock and `Folder` in the palette (#1341): the same view
 * with two marks, depending on which surface the user reached it from.
 */

import { Inbox } from "lucide-react";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import { useLayoutStore, useTabsStore, type DrawerView, type TabType } from "@/stores";
import type { PaletteItem } from "../types";

/** A surface that is both a drawer view and a tab of which there is only one. */
type SingletonTab = Extract<TabType, "variables" | "settings" | "inbox">;

interface ViewEntry {
	title: string;
	keywords: string[];
	icon: PaletteItem["icon"];
	/** The drawer view to reveal, when this surface has one. */
	drawerView?: DrawerView;
	/** The singleton tab to open, when this surface has one. */
	tabType?: SingletonTab;
}

/**
 * Search synonyms - the palette's own half, which the Dock has no use for.
 *
 * These are not names: they are what someone types when they are looking for a
 * view but do not know (or do not recall) what it is called. Keyed by
 * `DrawerView` rather than listed alongside a title, so a seventh view added to
 * `DRAWER_VIEWS` without a line here fails to compile instead of shipping a
 * row nobody can find.
 */
const VIEW_KEYWORDS: Record<DrawerView, string[]> = {
	collections: ["requests", "tree", "sidebar"],
	history: ["runs", "past", "results"],
	variables: ["environment", "globals", "{{", "substitution"],
	services: ["inbox", "webhook", "oauth", "issuer", "mock", "listener"],
	// "deleted" and "restore" are what someone types when they are looking for
	// this: they know what happened, not what the surface is called.
	trash: ["deleted", "restore", "undo", "removed", "recover"],
	settings: ["preferences", "options", "config"],
};

/**
 * The two drawer views that are also a singleton tab. Partial on purpose: the
 * other four have no tab, and saying so is not a gap.
 */
const VIEW_TABS: Partial<Record<DrawerView, SingletonTab>> = {
	variables: "variables",
	settings: "settings",
};

const VIEWS: ViewEntry[] = [
	...DRAWER_VIEWS.map(({ view, label, icon }) => ({
		title: label,
		keywords: VIEW_KEYWORDS[view],
		icon,
		drawerView: view,
		tabType: VIEW_TABS[view],
	})),
	// Kept beside Services, which lists inboxes and is where one is started:
	// this entry is the *tab*, the detail surface with the capture list, and
	// searching "inbox" should reach both. Not a drawer view, so it is a
	// literal rather than a seventh entry in the shared list.
	{ title: "Inbox", keywords: ["webhook", "receive", "callback"], icon: Inbox, tabType: "inbox" },
];

export function useViewItems(): PaletteItem[] {
	const openTab = useTabsStore((s) => s.openTab);
	const revealDrawerView = useLayoutStore((s) => s.revealDrawerView);

	return VIEWS.map((view) => ({
		id: `view:${view.title.toLowerCase()}`,
		kind: "view" as const,
		title: view.title,
		keywords: view.keywords,
		icon: view.icon,
		perform: () => {
			if (view.drawerView) revealDrawerView(view.drawerView);
			if (view.tabType) openTab({ type: view.tabType, entityId: null });
		},
	}));
}
