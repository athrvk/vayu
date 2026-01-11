import { Folder, History, Settings, Variable } from "lucide-react";
import { useAppStore } from "@/stores";
import type { SidebarTab } from "@/types";
import { Button, Tooltip, TooltipContent, TooltipTrigger, TooltipProvider, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import CollectionTree from "../collections/CollectionTree";
import HistoryList from "../history/HistoryList";
import { VariablesCategoryTree } from "../variables";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import ConnectionStatus from "../status/ConnectionStatus";

export default function Sidebar() {
	const { activeSidebarTab, setActiveSidebarTab, navigateToVariables } = useAppStore();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	const tabs: Array<{ id: SidebarTab; label: string; icon: typeof Folder }> = [
		{ id: "collections", label: "Collections", icon: Folder },
		{ id: "history", label: "History", icon: History },
		{ id: "variables", label: "Variables", icon: Variable },
		{ id: "settings", label: "Settings", icon: Settings },
	];

	const handleTabClick = (tabId: SidebarTab) => {
		if (tabId === "variables") {
			navigateToVariables();
		} else {
			setActiveSidebarTab(tabId);
		}
	};

	const renderContent = () => {
		switch (activeSidebarTab) {
			case "collections":
				return <CollectionTree />;
			case "history":
				return <HistoryList />;
			case "variables":
				return (
					<VariablesCategoryTree
						collections={collections}
						environments={environments}
					/>
				);
			case "settings":
				return (
					<div className="p-4 text-sm text-muted-foreground">
						Settings coming soon...
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<TooltipProvider>
			<div className="w-full bg-card border-r border-border flex flex-col h-full">
				{/* Tab Headers */}
				<div className="flex border-b border-border">
					{tabs.map((tab) => {
						const Icon = tab.icon;
						const isActive = activeSidebarTab === tab.id;
						return (
							<Tooltip key={tab.id}>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										onClick={() => handleTabClick(tab.id)}
										className={cn(
											"flex-1 flex flex-col items-center justify-center gap-1 px-2 py-3 h-auto min-w-0 rounded-none",
											isActive
												? "text-primary bg-primary/10 border-b-2 border-primary"
												: "text-muted-foreground hover:text-foreground hover:bg-accent"
										)}
									>
										<Icon className="w-5 h-5" />
										<span className="text-xs font-medium truncate text-center">{tab.label}</span>
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">
									{tab.label}
								</TooltipContent>
							</Tooltip>
						);
					})}
				</div>

				{/* Tab Content */}
				<ScrollArea className="flex-1">{renderContent()}</ScrollArea>

				<div className="mt-auto border-t border-border">
					<ConnectionStatus />
				</div>
			</div>
		</TooltipProvider>
	);
}
