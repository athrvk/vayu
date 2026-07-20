/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TooltipIconButton
 *
 * An icon-only button that is named and described from a single `label`: the
 * label becomes the accessible name (`aria-label`) and the visible tooltip.
 *
 * Icon buttons need both, and the two used to be supplied separately — or, more
 * often, only `title` was set, which is a weak substitute: a `title` tooltip
 * does not appear on keyboard focus, does not work on touch, cannot be styled,
 * and its screen-reader handling is inconsistent. Several buttons relied on it
 * and so had no proper name at all.
 *
 * This is the same Button-inside-Tooltip pattern the Dock, the collection-tree
 * header, and the response viewer already use; collapsing it into one component
 * means a new icon button gets a name and a real tooltip from a single prop
 * instead of re-assembling three elements each time (and forgetting one).
 *
 * Relies on the app-level `TooltipProvider` in `main.tsx`; no local provider.
 */

import * as React from "react";
import { Button, type ButtonProps } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export interface TooltipIconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
	/** Names the button (aria-label) and fills the tooltip. Required. */
	label: string;
	/** The icon. Kept as `icon` rather than children so the label can't be
	 *  mistaken for the visible content. */
	icon: React.ReactNode;
	/** Tooltip placement. Defaults to top, matching the Dock. */
	tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
	/** Extra tooltip line — e.g. a keyboard shortcut — shown but not named. */
	tooltipHint?: React.ReactNode;
}

export function TooltipIconButton({
	label,
	icon,
	tooltipSide = "top",
	tooltipHint,
	variant = "ghost",
	size = "icon",
	...props
}: TooltipIconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant={variant} size={size} aria-label={label} {...props}>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side={tooltipSide}>
				{tooltipHint ? (
					<span className="flex items-center gap-1.5">
						{label}
						<span className="text-muted-foreground">{tooltipHint}</span>
					</span>
				) : (
					label
				)}
			</TooltipContent>
		</Tooltip>
	);
}
