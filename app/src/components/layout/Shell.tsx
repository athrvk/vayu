
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useNavigationStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useResizable } from "@/hooks";
import { cn } from "@/lib/utils";
import Sidebar from "./Sidebar";
import RequestBuilder from "@/modules/request-builder";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsMain } from "@/modules/settings";
import VariablesMain from "@/modules/variables/main/VariablesMain";

const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;

export default function Shell() {
	const { resolveActiveScreen } = useNavigationStore();
	const activeScreen = resolveActiveScreen();
	const { triggerSave } = useSaveStore();

	const { size: sidebarWidth, isResizing, startResizing } = useResizable({
		defaultSize: 320,
		min: MIN_SIDEBAR_WIDTH,
		max: MAX_SIDEBAR_WIDTH,
	});

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
			{/* Sidebar container — controlled width */}
			<div
				style={{
					width: `${sidebarWidth}px`,
					minWidth: `${MIN_SIDEBAR_WIDTH}px`,
					maxWidth: `${MAX_SIDEBAR_WIDTH}px`,
				}}
				className="flex-shrink-0 flex flex-col overflow-hidden"
			>
				<Sidebar />
			</div>

			{/* Resize handle */}
			<div
				onMouseDown={startResizing}
				className={cn(
					"w-1 bg-border hover:bg-primary cursor-col-resize transition-colors shrink-0",
					isResizing && "bg-primary"
				)}
			/>

			{/* Main content */}
			<main className="flex-1 flex flex-col overflow-hidden min-w-0">
				{renderMainContent()}
			</main>
		</div>
	);
}
