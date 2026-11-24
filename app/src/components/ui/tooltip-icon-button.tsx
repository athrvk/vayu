/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An icon-only button named and described by one `label`: the accessible name (`aria-label`) and
 * the visible tooltip. `title` is a weak substitute: it does not show on keyboard focus or touch,
 * cannot be styled, and screen readers handle it inconsistently. The Button-inside-Tooltip pattern
 * the Dock, collection-tree header and response viewer use, in one component so a new icon button
 * gets both from one prop instead of reassembling three elements. Relies on `main.tsx`'s
 * `TooltipProvider`.
 */

import * as React from "react";
import { Button, type ButtonProps } from "./button";
import { Tooltip, TooltipContent, TooltipShortcutLabel, TooltipTrigger } from "./tooltip";

export interface TooltipIconButtonProps extends Omit<ButtonProps, "aria-label" | "children"> {
	/** Names the button (aria-label) and, unless `tooltip` says otherwise, fills the tooltip. Required. */
	label: string;
	/**
	 * The tooltip when it should differ from the name: a row button named for its row ("Restore
	 * Login") with the bare verb as tooltip, or a short toggle name with its effect explained.
	 * Defaults to `label`.
	 */
	tooltip?: string;
	/**
	 * The icon, as `icon` rather than children so the label is not mistaken for the visible
	 * content.
	 */
	icon: React.ReactNode;
	/** Tooltip placement. Defaults to top, matching the Dock. */
	tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
	/** Extra tooltip line - e.g. a keyboard shortcut - shown but not named. */
	tooltipHint?: React.ReactNode;
}

export function TooltipIconButton({
	label,
	tooltip = label,
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
					<TooltipShortcutLabel label={tooltip} shortcut={tooltipHint} />
				) : (
					tooltip
				)}
			</TooltipContent>
		</Tooltip>
	);
}
