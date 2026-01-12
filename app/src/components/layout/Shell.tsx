import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import Sidebar from "./Sidebar";
import RequestBuilder from "../request-builder";
import LoadTestDashboard from "../load-test-dashboard";
import HistoryDetail from "../history/HistoryDetail";
import WelcomeScreen from "../welcome/WelcomeScreen";
import { VariablesEditor } from "../variables";
import { cn } from "@/lib/utils";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 600;

export default function Shell() {
	const { activeScreen } = useAppStore();
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

	const handleMouseDown = () => {
		setIsResizing(true);
	};

	const handleMouseUp = () => {
		setIsResizing(false);
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!isResizing || !sidebarRef.current) return;

		const newWidth = e.clientX;
		if (newWidth >= MIN_SIDEBAR_WIDTH && newWidth <= MAX_SIDEBAR_WIDTH) {
			setSidebarWidth(newWidth);
		}
	};

	const renderMainContent = () => {
		switch (activeScreen) {
			case "request-builder":
				return <RequestBuilder />;
			case "dashboard":
				return <LoadTestDashboard />;
			case "history-detail":
				return <HistoryDetail />;
			case "variables":
				return <VariablesEditor />;
			case "welcome":
			default:
				return <WelcomeScreen />;
		}
	};

	return (
		<div
			className="flex h-screen bg-background"
			onMouseMove={handleMouseMove}
			onMouseUp={handleMouseUp}
			onMouseLeave={handleMouseUp}
		>
			<div
				ref={sidebarRef}
				style={{ width: `${sidebarWidth}px` }}
				className="flex-shrink-0 flex flex-col"
			>
				<Sidebar />
			</div>

			{/* Resize Handle */}
			<div
				onMouseDown={handleMouseDown}
				className={cn(
					"w-1 bg-border hover:bg-primary cursor-col-resize transition-colors",
					isResizing && "bg-primary"
				)}
				title="Drag to resize sidebar"
			/>

			<main className="flex-1 flex flex-col overflow-hidden">
				{renderMainContent()}
			</main>
		</div>
	);
}
