import { useState, useRef } from "react";
import { useAppStore } from "@/stores";
import Sidebar from "./Sidebar";
import RequestBuilder from "../request/RequestBuilder";
import LoadTestDashboard from "../dashboard/LoadTestDashboard";
import HistoryDetail from "../history/HistoryDetail";
import WelcomeScreen from "../welcome/WelcomeScreen";
import ConnectionStatus from "../status/ConnectionStatus";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 600;

export default function Shell() {
	const { activeScreen } = useAppStore();
	const [sidebarWidth, setSidebarWidth] = useState(320);
	const [isResizing, setIsResizing] = useState(false);
	const sidebarRef = useRef<HTMLDivElement>(null);

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
			case "welcome":
			default:
				return <WelcomeScreen />;
		}
	};

	return (
		<div
			className="flex h-screen bg-gray-50"
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
				className={`w-1 bg-gray-300 hover:bg-primary-500 cursor-col-resize transition-colors ${
					isResizing ? "bg-primary-500" : ""
				}`}
				title="Drag to resize sidebar"
			/>

			<main className="flex-1 flex flex-col overflow-hidden">
				{/* <ConnectionStatus /> */}
				{renderMainContent()}
			</main>
		</div>
	);
}
