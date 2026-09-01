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
 * **The open state is held here so a keyboard-dispatched click can open it**
 * (#1212). Radix's trigger listens on `pointerdown` and on its own `keydown`,
 * and neither hears `HTMLElement.click()` - which is exactly what the
 * collection tree's Shift+F10 / Menu / Shift+Enter keys dispatch at
 * `[data-tree-menu]` (`useRovingTreeFocus`). Every menu-only row action was
 * mouse-only for as long as that went unnoticed. The `detail === 0` test below
 * is what separates that click from a real one; see the handler.
 */

import { useRef, useState } from "react";
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
	/**
	 * Tab stop of the trigger. `0` by default, so an ordinary row's menu is
	 * reachable by Tab like any other control. A roving-tabindex tree passes
	 * `-1`: there the whole tree is one tab stop and the row's keys are the
	 * path in.
	 */
	tabIndex?: number;
}

export function RowActionsMenu({ label, actions, className, tabIndex = 0 }: RowActionsMenuProps) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	if (actions.length === 0) return null;

	const firstDestructive = actions.findIndex((a) => a.destructive);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					ref={trigger}
					variant="rowAction"
					size="icon"
					tabIndex={tabIndex}
					data-tree-menu
					aria-label={label}
					className={cn("h-6 w-6 shrink-0", className)}
					onClick={(e) => {
						e.stopPropagation();
						// A click with no pointer behind it - `.click()` from the
						// tree's key handler, or an assistive-tech activation -
						// reports `detail === 0`. A mouse click reports 1, and Radix
						// has already toggled on its pointerdown by the time it
						// arrives, so opening again here would close it on the way
						// down. Keyboard focus on the trigger itself is Radix's
						// keydown path, which preventDefaults and so never reaches
						// this handler at all.
						if (e.detail === 0) setOpen(true);
					}}
				>
					<MoreVertical className="h-3 w-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-40"
				onCloseAutoFocus={(e) => {
					// Radix hands focus back to the trigger. In a roving-tabindex
					// tree that control is deliberately not a tab stop, so the row
					// it belongs to is where focus has to land - otherwise Escape
					// leaves the tree's one stop on something Tab cannot return to.
					const row = trigger.current?.closest<HTMLElement>('[role="treeitem"]');
					if (!row) return;
					e.preventDefault();
					row.focus();
				}}
			>
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
								action.destructive && "text-destructive-text"
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
