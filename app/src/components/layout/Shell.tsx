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
import RequestBuilder from "@/modules/request-builder";
import CollectionDetail from "@/modules/collections/CollectionDetail";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsLayout } from "@/modules/settings";
import VariablesMain from "@/modules/variables/main/VariablesMain";

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
			return <SettingsLayout />;
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
		} else if (activeTab?.type === "collection" || activeTab?.type === "request") {
			setDrawerOpen(true);
			setDrawerView("collections");
		}
	}, [activeTab?.type, activeTab?.entityId, setDrawerOpen, setDrawerView]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			const key = e.key.toLowerCase();

			// ⇧⌘E / ⇧⌘H / ⇧⌘U — drawer view switchers (match Dock tooltips)
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
			<div className="flex flex-1 overflow-hidden relative">
				{/* Settings renders like any other tab — Drawer + ContextBar stay
				    mounted. It used to take over the whole row, which left the Dock's
				    drawer buttons dead (they toggle drawer state with no Drawer to
				    show). */}
				<Drawer />
				<main className="flex-1 overflow-hidden flex flex-col min-w-0">
					{renderTabContent(activeTab)}
				</main>
				<ContextBar mode={windowWidth >= 1200 ? "push" : "overlay"} />
			</div>
			<Dock />
		</div>
	);
}
