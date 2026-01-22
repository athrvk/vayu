
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, useRef, useEffect } from "react";
import { useNavigationStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import Sidebar from "./Sidebar";
// Main content modules (displayed in main content area)
import RequestBuilder from "@/modules/request-builder";
import LoadTestDashboard from "@/modules/dashboard";
import { HistoryDetail } from "@/modules/history/main";
import WelcomeScreen from "@/modules/welcome/WelcomeScreen";
import { SettingsMain } from "@/modules/settings";
import VariablesMain from "@/modules/variables/main/VariablesMain";
import { cn } from "@/lib/utils";

const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;

export default function Shell() {
	const { resolveActiveScreen } = useNavigationStore();
	const activeScreen = resolveActiveScreen();
	const { triggerSave } = useSaveStore();
	const [sidebarWidth, setSidebarWidth] = useState(320);
	const [isResizing, setIsResizing] = useState(false);
	const sidebarRef = useRef<HTMLDivElement>(null);

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

	// Global mouse event handlers for resizing
	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isResizing) return;

			const newWidth = e.clientX;
			if (newWidth >= MIN_SIDEBAR_WIDTH && newWidth <= MAX_SIDEBAR_WIDTH) {
				setSidebarWidth(newWidth);
			}
		};

		const handleMouseUp = () => {
			setIsResizing(false);
		};

		if (isResizing) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
	}, [isResizing]);

	const handleMouseDown = () => {
		setIsResizing(true);
	};

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
			{/* Sidebar Container - Handles width constraints */}
			<div
				ref={sidebarRef}
				style={{
					width: `${sidebarWidth}px`,
					minWidth: `${MIN_SIDEBAR_WIDTH}px`,
					maxWidth: `${MAX_SIDEBAR_WIDTH}px`,
				}}
				className="flex-shrink-0 flex flex-col overflow-hidden"
			>
				<Sidebar />
			</div>

			{/* Resize Handle */}
			<div
				onMouseDown={handleMouseDown}
				className={cn(
					"w-1 bg-border hover:bg-primary cursor-col-resize transition-colors shrink-0",
					isResizing && "bg-primary"
				)}
				title="Drag to resize sidebar"
			/>

			{/* Main Content Container - Handles overflow */}
			<main className="flex-1 flex flex-col overflow-hidden min-w-0">
				{renderMainContent()}
			</main>
		</div>
	);
}
