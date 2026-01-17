
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Folder, History, Settings, Variable } from "lucide-react";
import { useNavigationStore } from "@/stores";
import type { SidebarTab } from "@/types";
import {
	Button,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipProvider,
	ScrollArea,
} from "@/components/ui";
import { cn } from "@/lib/utils";
// Sidebar modules (displayed in left sidebar)
import CollectionTree from "@/modules/collections/CollectionTree";
import { HistoryList } from "@/modules/history/sidebar";
import { VariablesCategoryTree } from "@/modules/variables/sidebar";
import { SettingsCategoryTree } from "@/modules/settings";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import ConnectionStatus from "../status/ConnectionStatus";

export default function Sidebar() {
	const { activeSidebarTab, setActiveSidebarTab, navigateToVariables, navigateToSettings } =
		useNavigationStore();
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
		} else if (tabId === "settings") {
			navigateToSettings();
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
					<VariablesCategoryTree collections={collections} environments={environments} />
				);
			case "settings":
				return <SettingsCategoryTree />;
			default:
				return null;
		}
	};

	return (
		<TooltipProvider>
			{/* Sidebar Container - Handles all width and overflow constraints */}
			<div className="w-full h-full bg-card border-r border-border flex flex-col overflow-hidden">
				{/* Tab Headers - Fixed height, handles text truncation */}
				<div className="flex border-b border-border shrink-0 min-w-0">
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
										<Icon className="w-5 h-5 shrink-0" />
										<span className="text-xs font-medium truncate text-center w-full">
											{tab.label}
										</span>
									</Button>
								</TooltipTrigger>
								<TooltipContent side="bottom">{tab.label}</TooltipContent>
							</Tooltip>
						);
					})}
				</div>

				{/* Tab Content - Handles overflow, children just fill space */}
				<div className="flex-1 min-h-0 min-w-0 overflow-hidden">
					<ScrollArea className="h-full w-full">
						<div className="w-full min-w-0">{renderContent()}</div>
					</ScrollArea>
				</div>

				{/* Footer - Fixed height, always visible at bottom */}
				<div className="shrink-0 border-t border-border z-10">
					<ConnectionStatus />
				</div>
			</div>
		</TooltipProvider>
	);
}
