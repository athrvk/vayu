/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, useState } from "react";
import { useTabsStore, useSaveStore, useLayoutStore, type Tab } from "@/stores";
import { ImportModal } from "@/modules/collections/ImportModal";
import { Drawer } from "./Drawer";
import { Dock } from "./Dock";
import { ContextBar } from "./ContextBar";
import RequestBuilder from "@/modules/request-builder";
import CollectionDetail from "@/modules/collections/CollectionDetail";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsMain } from "@/modules/settings";
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
			return <SettingsMain />;
		default:
			return null;
	}
}

export default function Shell() {
	const { openTabs, activeTabId, closeTab, focusTab } = useTabsStore();
	const { toggleDrawer } = useLayoutStore();
	const { triggerSave } = useSaveStore();
	const [windowWidth, setWindowWidth] = useState(window.innerWidth);

	useEffect(() => {
		const onResize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey) {
				switch (e.key) {
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
					default:
						if (e.key >= "1" && e.key <= "9") {
							const tab = openTabs[parseInt(e.key) - 1];
							if (tab) {
								e.preventDefault();
								focusTab(tab.id);
							}
						}
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [triggerSave, closeTab, toggleDrawer, focusTab, activeTabId, openTabs]);

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			<ImportModal />
			<div className="flex flex-1 overflow-hidden relative">
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
