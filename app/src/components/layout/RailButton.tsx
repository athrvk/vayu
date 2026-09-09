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
	 * Which window edge this button's rail sits on - which side the active
	 * indicator (for the `"indicator"` variant) paints on, and which side the
	 * tooltip opens on. The tooltip always opens away from the window edge:
	 * a rail on the right edge whose tooltip opened further right would run
	 * off-screen.
	 */
	side: "left" | "right";
	/**
	 * `"indicator"` paints a 2px accent bar on `side` when active and nothing
	 * else - the IntelliJ/VS Code convention for a rail's current item - so
	 * the rail never reads as a row of filled tiles. `ActivityRail` uses this:
	 * one mutually-exclusive choice of what the Drawer shows.
	 * `"tile"` is the app's ordinary icon-toggle look (`bg-accent`), for a
	 * multi-select set of buttons rather than one current item -
	 * `ContextRail`'s sections, any of which can be expanded at once.
	 */
	variant: "indicator" | "tile";
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
	side,
	variant,
	tabIndex,
}: RailButtonProps) {
	const borderSide = side === "left" ? "border-l-2" : "border-r-2";
	const activeClass =
		variant === "tile"
			? "bg-accent text-accent-foreground"
			: cn(
					"text-foreground",
					borderSide,
					side === "left" ? "border-l-primary" : "border-r-primary"
				);
	const idleClass = cn(
		"text-muted-foreground hover:bg-muted/50 hover:text-foreground",
		variant === "indicator" &&
			cn(borderSide, side === "left" ? "border-l-transparent" : "border-r-transparent")
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
			{/* Away from the window edge this button's rail sits on - see the `side` doc above. */}
			<TooltipContent side={side === "left" ? "right" : "left"}>
				<p>{shortcut ? `${label} ${shortcut}` : label}</p>
			</TooltipContent>
		</Tooltip>
	);
}
