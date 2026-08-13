/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { useTabsStore, useSaveStore, useLayoutStore, type Tab, type DrawerView } from "@/stores";
import { ImportModal } from "@/modules/collections/ImportModal";
import { Drawer } from "./Drawer";
import { Dock } from "./Dock";
import { ContextBar } from "./ContextBar";
import { TabStrip } from "./TabStrip";
import RequestBuilder from "@/modules/request-builder";
import CollectionDetail from "@/modules/collections/CollectionDetail";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsMain } from "@/modules/settings";
import VariablesMain from "@/modules/variables/main/VariablesMain";
import InboxView from "@/modules/inbox";
import { CommandPalette } from "@/modules/palette";

function renderTabContent(tab: Tab | null): React.ReactNode {
	if (!tab) return <WelcomeScreen />;
	switch (tab.type) {
		case "welcome":
			return <WelcomeScreen />;
		case "request":
			return tab.entityId ? <RequestBuilder /> : <WelcomeScreen />;
		case "collection":
			return tab.entityId ? <CollectionDetail /> : null;
		case "dashboard":
			return <LoadTestDashboard />;
		case "run":
			return tab.entityId ? <HistoryDetail /> : null;
		case "variables":
			return <VariablesMain />;
		case "settings":
			return <SettingsMain />;
		case "inbox":
			return <InboxView />;
		default:
			return null;
	}
}

export default function Shell() {
	const { openTabs, activeTabId, closeTab, focusTab, openTab } = useTabsStore();
	const { toggleDrawer, activateDrawerView, toggleContextBar, setDrawerOpen, setDrawerView } =
		useLayoutStore();
	const { triggerSave } = useSaveStore();
	const [windowWidth, setWindowWidth] = useState(window.innerWidth);

	useEffect(() => {
		const onResize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;

	// Auto-open the matching drawer view when navigating to a tab whose entity
	// lives in a drawer (collections tree for requests/collections, variables list).
	useEffect(() => {
		if (activeTab?.type === "variables") {
			setDrawerOpen(true);
			setDrawerView("variables");
		} else if (activeTab?.type === "settings") {
			setDrawerOpen(true);
			setDrawerView("settings");
		} else if (activeTab?.type === "collection" || activeTab?.type === "request") {
			setDrawerOpen(true);
			setDrawerView("collections");
		} else if (activeTab?.type === "run") {
			/*
			 * A run's list is History, so a run tab belongs with it - and with the
			 * drawer open. It had no branch at all, which was not quite the same as
			 * "leave it alone": the drawer never *opened*, so picking a run while it
			 * was closed left the sidebar shut.
			 *
			 * The guard this has to respect is the older bug where opening a run
			 * threw the user out of the History list. Selecting History satisfies
			 * that rather than violating it - the failure then was landing
			 * somewhere else.
			 */
			setDrawerOpen(true);
			setDrawerView("history");
		} else if (activeTab?.type === "dashboard") {
			/*
			 * Deliberately nothing. Written out rather than left to fall off the
			 * end, because "no branch" is what made the `run` case a bug for so
			 * long - it is indistinguishable from nobody having considered it, and
			 * the next person adding branches for completeness would add one here.
			 *
			 * The dashboard is a detour from a request, not a list item: it is
			 * opened only by the request builder when a load test starts, carries
			 * `entityId: null`, and its back button returns to `sourceRequestId`
			 * rather than closing. So when it opens, the drawer is already on
			 * Collections with that request revealed - which is both where the user
			 * came from and where Back sends them. Switching to History would
			 * discard exactly that context, twice per round trip.
			 *
			 * A judgement call, not a forced one: a running test *does* appear in
			 * History (`listRuns` applies no status filter, and the sidebar offers
			 * a "Running" filter), so showing History here would not be
			 * nonsensical - just contrary to the flow.
			 */
		}
	}, [activeTab?.type, activeTab?.entityId, setDrawerOpen, setDrawerView]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();

			// ⇧⌘E / ⇧⌘H / ⇧⌘U - drawer view switchers (match Dock tooltips)
			if (e.shiftKey) {
				const views: Record<string, DrawerView> = {
					e: "collections",
					h: "history",
					u: "variables",
				};
				const view = views[key];
				if (view) {
					e.preventDefault();
					activateDrawerView(view);
				}
				return;
			}

			switch (key) {
				case "s":
					e.preventDefault();
					triggerSave();
					break;
				case "w":
					e.preventDefault();
					if (activeTabId) closeTab(activeTabId);
					break;
				case "b":
					e.preventDefault();
					toggleDrawer();
					break;
				case "i":
					e.preventDefault();
					toggleContextBar();
					break;
				case ",":
					e.preventDefault();
					openTab({ type: "settings", entityId: null });
					break;
				default:
					if (key >= "1" && key <= "9") {
						const tab = openTabs[parseInt(key) - 1];
						if (tab) {
							e.preventDefault();
							focusTab(tab.id);
						}
					}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		triggerSave,
		closeTab,
		toggleDrawer,
		toggleContextBar,
		activateDrawerView,
		openTab,
		focusTab,
		activeTabId,
		openTabs,
	]);

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			<ImportModal />
			{/* Mounted once, like the import modal: it is summoned from a chord
			    rather than from anything on screen, and its own ⌘K listener is
			    what opens it. It owns that chord rather than the keydown map
			    below - see the capture-phase note in CommandPalette. */}
			<CommandPalette />
			{/* Every tab uses the same shell: one left Drawer (its view switches
			    with the tab - collections/history/variables/settings), the main
			    content, and the request-only ContextBar. No tab type takes over
			    the row, so the Dock's drawer switchers always have a Drawer to act
			    on. */}
			<div className="flex flex-1 overflow-hidden">
				<Drawer />
				{/*
				 * The content column: tab strip on top, then main + ContextBar.
				 *
				 * The strip is scoped to this column rather than spanning the window
				 * because that is the region tabs actually switch - the drawer is a
				 * global navigator and keeps its own header band beside this row.
				 * Its left edge therefore follows the drawer's resize handle for
				 * free: the column is the drawer's flex sibling, so there is no
				 * width to compute or keep in sync.
				 *
				 * `relative` moved down with the strip, onto the main+context row:
				 * the ContextBar's overlay mode (<1200px) positions against its
				 * nearest positioned ancestor, and from the outer row it would now
				 * cover the tabs it belongs to.
				 */}
				<div className="flex flex-1 flex-col min-w-0 overflow-hidden">
					<TabStrip />
					<div className="flex flex-1 overflow-hidden relative">
						<main className="flex-1 overflow-hidden flex flex-col min-w-0">
							{renderTabContent(activeTab)}
						</main>
						<ContextBar mode={windowWidth >= 1200 ? "push" : "overlay"} />
					</div>
				</div>
			</div>
			<Dock />
		</div>
	);
}
