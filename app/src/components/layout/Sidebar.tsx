import { Folder, History, Settings, Database } from "lucide-react";
import { useAppStore } from "@/stores";
import type { SidebarTab } from "@/types";
import CollectionTree from "../collections/CollectionTree";
import HistoryList from "../history/HistoryList";
import EnvironmentManager from "../environment/EnvironmentManager";

export default function Sidebar() {
	const { activeSidebarTab, setActiveSidebarTab } = useAppStore();

	const tabs: Array<{ id: SidebarTab; label: string; icon: typeof Folder }> = [
		{ id: "collections", label: "Collections", icon: Folder },
		{ id: "history", label: "History", icon: History },
		{ id: "environments", label: "Environments", icon: Database },
		{ id: "settings", label: "Settings", icon: Settings },
	];

	const renderContent = () => {
		switch (activeSidebarTab) {
			case "collections":
				return <CollectionTree />;
			case "history":
				return <HistoryList />;
			case "environments":
				return <EnvironmentManager />;
			case "settings":
				return (
					<div className="p-4 text-sm text-gray-500">
						Settings coming soon...
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<div className="w-full bg-white border-r border-gray-200 flex flex-col h-full">
			{/* Tab Headers */}
			<div className="flex border-b border-gray-200">
				{tabs.map((tab) => {
					const Icon = tab.icon;
					const isActive = activeSidebarTab === tab.id;
					return (
						<button
							key={tab.id}
							onClick={() => setActiveSidebarTab(tab.id)}
							className={`flex-1 flex flex-col items-center justify-center gap-1 px-2 py-3 text-xs font-medium transition-colors min-w-0 ${
								isActive
									? "text-primary-600 bg-primary-50 border-b-2 border-primary-600"
									: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
							}`}
							title={tab.label}
						>
							<Icon className="w-5 h-5" />
							<span className="truncate text-center">{tab.label}</span>
						</button>
					);
				})}
			</div>

			{/* Tab Content */}
			<div className="flex-1 overflow-auto">{renderContent()}</div>
		</div>
	);
}
