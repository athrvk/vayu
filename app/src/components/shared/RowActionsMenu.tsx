/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RowActionsMenu
 *
 * The "⋯" menu for a list row (a request, an environment). One component so
 * every row exposes its actions the same way, instead of each surface growing
 * its own inline delete button with its own hover treatment.
 *
 * Built on the DropdownMenu primitive rather than a hand-rolled popover so it
 * gets focus management, Escape-to-close and arrow-key navigation for free.
 *
 * The trigger carries `data-tree-menu`, so inside the collection tree the
 * Shift+F10 / Menu key path opens it (every control in a tree row is
 * tabIndex=-1 — see useRovingTreeFocus).
 */

import { MoreVertical, type LucideIcon } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export interface RowAction {
	label: string;
	icon: LucideIcon;
	onSelect: () => void;
	/** Renders in destructive colour and is separated from the actions above. */
	destructive?: boolean;
	disabled?: boolean;
}

interface RowActionsMenuProps {
	/** Names the control for screen readers, e.g. "More actions for Get users". */
	label: string;
	actions: RowAction[];
	/** Extra classes for the trigger (sizing lives with the calling row). */
	className?: string;
}

export function RowActionsMenu({ label, actions, className }: RowActionsMenuProps) {
	if (actions.length === 0) return null;

	const firstDestructive = actions.findIndex((a) => a.destructive);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="rowAction"
					size="icon"
					tabIndex={-1}
					data-tree-menu
					aria-label={label}
					className={cn("h-6 w-6 shrink-0", className)}
					onClick={(e) => e.stopPropagation()}
				>
					<MoreVertical className="h-3 w-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				{actions.map((action, i) => (
					<div key={action.label}>
						{action.destructive && i === firstDestructive && i > 0 && (
							<DropdownMenuSeparator />
						)}
						<DropdownMenuItem
							disabled={action.disabled}
							onSelect={action.onSelect}
							className={cn(
								"gap-2 text-sm",
								action.destructive && "text-destructive"
							)}
						>
							<action.icon className="h-4 w-4 shrink-0" />
							{action.label}
						</DropdownMenuItem>
					</div>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
