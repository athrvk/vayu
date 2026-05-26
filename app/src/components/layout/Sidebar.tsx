
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState } from "react";
import { Folder, Clock, Code2, Settings2 } from "lucide-react";
import { useNavigationStore } from "@/stores";
import type { SidebarTab } from "@/types";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipProvider,
	ScrollArea,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import CollectionTree from "@/modules/collections/CollectionTree";
import { HistoryList } from "@/modules/history/sidebar";
import { VariablesCategoryTree } from "@/modules/variables/sidebar";
import { SettingsCategoryTree } from "@/modules/settings";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import ConnectionStatus from "../status/ConnectionStatus";

const TOP_TABS: Array<{ id: SidebarTab; label: string; icon: typeof Folder }> = [
	{ id: "collections", label: "Collections", icon: Folder },
	{ id: "history",     label: "History",     icon: Clock },
	{ id: "variables",   label: "Variables",   icon: Code2 },
];

const BOTTOM_TAB = { id: "settings" as SidebarTab, label: "Settings", icon: Settings2 };

function ActivityTabButton({
	tab,
	isActive,
	onClick,
}: {
	tab: { id: SidebarTab; label: string; icon: typeof Folder };
	isActive: boolean;
	onClick: (id: SidebarTab) => void;
}) {
	const Icon = tab.icon;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="relative w-full flex justify-center">
					{/* Active indicator — 2px left accent bar */}
					{isActive && (
						<span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-sm" />
					)}
					<button
						onClick={() => onClick(tab.id)}
						className={cn(
							"w-10 h-10 flex items-center justify-center rounded-md transition-colors duration-100",
							isActive
								? "bg-primary/10 text-primary"
								: "text-muted-foreground hover:bg-accent hover:text-foreground"
						)}
						aria-label={tab.label}
					>
						<Icon className="w-4 h-4" />
					</button>
				</div>
			</TooltipTrigger>
			<TooltipContent side="right">{tab.label}</TooltipContent>
		</Tooltip>
	);
}

function ActivityBar({
	activeSidebarTab,
	panelOpen,
	onTabClick,
}: {
	activeSidebarTab: SidebarTab;
	panelOpen: boolean;
	onTabClick: (id: SidebarTab) => void;
}) {
	return (
		<div className="w-11 h-full bg-panel border-r border-border flex flex-col items-center py-1.5 shrink-0">
			<div className="flex flex-col items-center gap-0.5 w-full">
				{TOP_TABS.map((tab) => (
					<ActivityTabButton
						key={tab.id}
						tab={tab}
						isActive={activeSidebarTab === tab.id && panelOpen}
						onClick={onTabClick}
					/>
				))}
			</div>

			<div className="flex-1" />

			<ActivityTabButton
				tab={BOTTOM_TAB}
				isActive={activeSidebarTab === "settings" && panelOpen}
				onClick={onTabClick}
			/>
		</div>
	);
}

function SidebarPanel({
	activeSidebarTab,
	collections,
	environments,
}: {
	activeSidebarTab: SidebarTab;
	collections: ReturnType<typeof useCollectionsQuery>["data"];
	environments: ReturnType<typeof useEnvironmentsQuery>["data"];
}) {
	const renderContent = () => {
		switch (activeSidebarTab) {
			case "collections":
				return <CollectionTree />;
			case "history":
				return <HistoryList />;
			case "variables":
				return (
					<VariablesCategoryTree
						collections={collections ?? []}
						environments={environments ?? []}
					/>
				);
			case "settings":
				return <SettingsCategoryTree />;
			default:
				return null;
		}
	};

	return (
		<div className="flex-1 min-w-0 h-full bg-panel border-r border-border flex flex-col overflow-hidden">
			<div className="flex-1 min-h-0 overflow-hidden">
				<ScrollArea className="h-full w-full">
					<div className="w-full min-w-0">{renderContent()}</div>
				</ScrollArea>
			</div>

			<div className="shrink-0 border-t border-border z-10">
				<ConnectionStatus />
			</div>
		</div>
	);
}

export default function Sidebar() {
	const { activeSidebarTab, setActiveSidebarTab, navigateToVariables, navigateToSettings } =
		useNavigationStore();
	const { data: collections } = useCollectionsQuery();
	const { data: environments } = useEnvironmentsQuery();
	const [panelOpen, setPanelOpen] = useState(true);

	const handleTabClick = (tabId: SidebarTab) => {
		// Clicking the active tab while panel is open → collapse
		if (tabId === activeSidebarTab && panelOpen) {
			setPanelOpen(false);
			return;
		}

		setPanelOpen(true);

		if (tabId === "variables") {
			navigateToVariables();
		} else if (tabId === "settings") {
			navigateToSettings();
		} else {
			setActiveSidebarTab(tabId);
		}
	};

	return (
		<TooltipProvider>
			<div className="flex h-full shrink-0">
				<ActivityBar
					activeSidebarTab={activeSidebarTab}
					panelOpen={panelOpen}
					onTabClick={handleTabClick}
				/>
				{panelOpen && (
					<SidebarPanel
						activeSidebarTab={activeSidebarTab}
						collections={collections}
						environments={environments}
					/>
				)}
			</div>
		</TooltipProvider>
	);
}
