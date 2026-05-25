
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useNavigationStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import Sidebar from "./Sidebar";
import RequestBuilder from "@/modules/request-builder";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsMain } from "@/modules/settings";
import VariablesMain from "@/modules/variables/main/VariablesMain";

export default function Shell() {
	const { resolveActiveScreen } = useNavigationStore();
	const activeScreen = resolveActiveScreen();
	const { triggerSave } = useSaveStore();

	// App-wide Ctrl/Cmd+S keyboard handler
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				triggerSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [triggerSave]);

	const renderMainContent = () => {
		switch (activeScreen) {
			case "request-builder":
				return <RequestBuilder />;
			case "dashboard":
				return <LoadTestDashboard />;
			case "history":
				return <HistoryDetail />;
			case "settings":
				return <SettingsMain />;
			case "variables":
				return <VariablesMain />;
			case "welcome":
			default:
				return <WelcomeScreen />;
		}
	};

	return (
		<div className="flex h-full bg-background overflow-hidden">
			<Sidebar />
			<main className="flex-1 flex flex-col overflow-hidden min-w-0">
				{renderMainContent()}
			</main>
		</div>
	);
}
