/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { FolderOpen, Clock, Zap, PanelRight, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatChord } from "@/lib/platform";
import {
	useLayoutStore,
	useEngineStore,
	useSaveStore,
	useTabsStore,
	type DrawerView,
} from "@/stores";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui";

interface DrawerButton {
	view: DrawerView;
	icon: React.ReactNode;
	label: string;
	shortcut: string;
}

const DRAWER_BUTTONS: DrawerButton[] = [
	{
		view: "collections",
		icon: <FolderOpen size={15} />,
		label: "Collections",
		shortcut: formatChord({ mod: true, shift: true, key: "E" }),
	},
	{
		view: "history",
		icon: <Clock size={15} />,
		label: "History",
		shortcut: formatChord({ mod: true, shift: true, key: "H" }),
	},
	{
		view: "variables",
		icon: <Zap size={15} />,
		label: "Variables",
		shortcut: formatChord({ mod: true, shift: true, key: "U" }),
	},
];

interface DockButtonProps {
	active: boolean;
	onClick: () => void;
	tooltip: string;
	children: React.ReactNode;
}

function DockButton({ active, onClick, tooltip, children }: DockButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					onClick={onClick}
					className={cn(
						"flex items-center justify-center w-7 h-7 rounded-md text-xs transition-colors",
						active
							? "bg-accent text-accent-foreground"
							: "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
					)}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<p>{tooltip}</p>
			</TooltipContent>
		</Tooltip>
	);
}

export function Dock() {
	const { drawerOpen, drawerView, activateDrawerView, contextBarOpen, toggleContextBar } =
		useLayoutStore();
	const { isEngineConnected } = useEngineStore();
	const { status: saveStatus } = useSaveStore();
	const { openTab } = useTabsStore();

	return (
		<TooltipProvider>
			<div className="flex items-center h-8 px-2 gap-2 border-t border-border bg-panel shrink-0">
				{/* Left — drawer switchers */}
				<div className="flex items-center gap-0.5">
					{DRAWER_BUTTONS.map(({ view, icon, label, shortcut }) => (
						<DockButton
							key={view}
							active={drawerOpen && drawerView === view}
							onClick={() => activateDrawerView(view)}
							tooltip={`${label} ${shortcut}`}
						>
							{icon}
						</DockButton>
					))}
				</div>

				{/* Middle — ambient status */}
				<div className="flex-1 flex items-center justify-center gap-4">
					<span
						className={cn(
							"flex items-center gap-1 text-xs",
							isEngineConnected ? "text-status-success" : "text-muted-foreground"
						)}
					>
						<span className="w-1.5 h-1.5 rounded-full bg-current" />
						{isEngineConnected ? "Connected" : "Disconnected"}
					</span>

					{saveStatus === "saving" && (
						<span className="text-xs text-muted-foreground">Saving…</span>
					)}
					{saveStatus === "saved" && (
						<span className="text-xs text-muted-foreground">Saved</span>
					)}
					{saveStatus === "error" && (
						<span className="text-xs text-destructive">Save failed</span>
					)}

					<span className="text-xs text-muted-foreground/50">v{__VAYU_VERSION__}</span>
				</div>

				{/* Right — toggles */}
				<div className="flex items-center gap-0.5">
					<DockButton
						active={contextBarOpen}
						onClick={toggleContextBar}
						tooltip={`Toggle context bar (${formatChord({ mod: true, key: "I" })})`}
					>
						<PanelRight size={15} />
					</DockButton>
					<DockButton
						active={false}
						onClick={() => openTab({ type: "settings", entityId: null })}
						tooltip={`Settings (${formatChord({ mod: true, key: "," })})`}
					>
						<Settings size={15} />
					</DockButton>
				</div>
			</div>
		</TooltipProvider>
	);
}
