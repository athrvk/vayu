/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";

export interface RailButtonProps {
	active: boolean;
	onClick: () => void;
	/** What the button is. Becomes both the accessible name and the tooltip. */
	label: string;
	/** Shown after the label in the tooltip; deliberately not in the name. */
	shortcut?: string;
	children: React.ReactNode;
	/**
	 * `"edge-left"` / `"edge-right"` paint a 2px accent bar on that side when
	 * active - the IntelliJ/VS Code convention for a rail's current item - and
	 * nothing else, so the rail never reads as a row of filled tiles. `"tile"`
	 * is the app's ordinary icon-toggle look (`bg-accent`), for a rail button
	 * that is not primary navigation.
	 */
	variant: "edge-left" | "edge-right" | "tile";
	/** Roving tabindex: -1 for every button but the one arrow keys would land on. */
	tabIndex?: number;
}

/**
 * The icon-only button shared by `ActivityRail` and `ContextRail`.
 *
 * Extracted from what was `Dock`'s own `DockButton`: both rails need the same
 * accessible-name-from-`label`, shortcut-out-of-the-name shape, and the Dock
 * itself no longer has a button of this kind once its two switchers move out
 * (issue #1615).
 */
export function RailButton({
	active,
	onClick,
	label,
	shortcut,
	children,
	variant,
	tabIndex,
}: RailButtonProps) {
	const activeClass =
		variant === "tile"
			? "bg-accent text-accent-foreground"
			: cn(
					"text-foreground",
					variant === "edge-left"
						? "border-l-2 border-l-primary"
						: "border-r-2 border-r-primary"
				);
	const idleClass =
		variant === "tile"
			? "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
			: cn(
					"text-muted-foreground hover:bg-muted/50 hover:text-foreground",
					variant === "edge-left"
						? "border-l-2 border-l-transparent"
						: "border-r-2 border-r-transparent"
				);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					onClick={onClick}
					aria-label={label}
					aria-pressed={active}
					tabIndex={tabIndex}
					className={cn(
						"relative flex items-center justify-center w-full h-9 text-xs transition-colors",
						variant === "tile" && "rounded-md",
						active ? activeClass : idleClass
					)}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side={variant === "edge-right" ? "left" : "right"}>
				<p>{shortcut ? `${label} ${shortcut}` : label}</p>
			</TooltipContent>
		</Tooltip>
	);
}
