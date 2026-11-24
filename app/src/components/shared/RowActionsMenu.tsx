/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The "⋯" menu for a list row (a request, an environment), so every row exposes actions one way, on
 * the DropdownMenu primitive for focus management, Escape and arrow keys. **The open state is held
 * here so a keyboard-dispatched click can open it** (#1212): Radix's trigger listens on
 * `pointerdown` and its own `keydown`, and neither hears `HTMLElement.click()`, which the
 * collection tree's Shift+F10 / Menu / Shift+Enter dispatch at `[data-tree-menu]`
 * (`useRovingTreeFocus`); the `detail === 0` test below tells that click from a real one. **The
 * trigger shows its label on focus, but not on the focus the menu hands back** (#3498): icon-only,
 * it takes the app's `Tooltip`, and a tooltip on a closing menu's returned focus would cover the
 * row just acted on, so the close marks the hand-back and the focus handler declines it.
 */

import { Fragment, useRef, useState, type FocusEvent } from "react";
import { MoreVertical } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useAfterMenuClose } from "./useAfterMenuClose";
// The list, grouping rule and item drawing live beside this file: right-click offers the same
// actions through another Radix family (`RowContextMenu`), and one would drift.
import { rowActionRows, rowActionItemClass, type RowAction } from "./row-actions";
import { RowActionBody } from "./RowActionBody";

interface RowActionsMenuProps {
	/** Names the control for screen readers, e.g. "More actions for Get users". */
	label: string;
	actions: RowAction[];
	/** Extra classes for the trigger (sizing lives with the calling row). */
	className?: string;
	/**
	 * The trigger's tab stop: `0` by default, reachable by Tab; a roving-tabindex tree passes `-1`,
	 * as the whole tree is one stop and the row's keys are the way in.
	 */
	tabIndex?: number;
	/**
	 * Runs after the roving-tree focus return, when the menu has one (#1608's element-card Rename):
	 * the signal Radix uses to return focus, fired once the closing content's cleanup (its
	 * `FocusScope` trap, the `aria-hidden` on the page) is done, not after a guessed delay. A
	 * caller autofocusing its own target on close (an inline rename input) calls
	 * `event.preventDefault()` here, as the tree-row branch does.
	 */
	onCloseAutoFocus?: (event: Event) => void;
}

export function RowActionsMenu({
	label,
	actions,
	className,
	tabIndex = 0,
	onCloseAutoFocus,
}: RowActionsMenuProps) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	// True only while the closing menu returns focus to the trigger. Radix focuses it synchronously
	// in `onCloseAutoFocus`, so the flag clears on a microtask: a close sending focus elsewhere (a
	// field, a tree row, a click outside) leaves no stale flag.
	const focusReturning = useRef(false);
	const { onSelectOf, runDeferred } = useAfterMenuClose();

	if (actions.length === 0) return null;

	// Runs before Radix's focus handler, which opens the tooltip only when not default-prevented.
	const declineReturnedFocus = (e: FocusEvent) => {
		if (focusReturning.current) e.preventDefault();
	};

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild onFocus={declineReturnedFocus}>
					<DropdownMenuTrigger asChild>
						<Button
							ref={trigger}
							variant="rowAction"
							size="icon"
							tabIndex={tabIndex}
							data-tree-menu
							aria-label={label}
							className={cn("size-target shrink-0", className)}
							onClick={(e) => {
								e.stopPropagation();
								// A click with no pointer (`.click()` from the tree's keys, an
								// assistive-tech activation) reports `detail === 0`. A mouse click
								// reports 1 after Radix toggled on pointerdown, so opening here
								// would close it. Keyboard focus on the trigger is Radix's keydown
								// path, which preventDefaults and never reaches this.
								if (e.detail === 0) setOpen(true);
							}}
						>
							<MoreVertical className="size-icon-sm" />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				{/*
				 * The verb alone: the name carries the row ("More actions for Get users"), as
				 * `TooltipIconButton`'s `tooltip` does.
				 */}
				<TooltipContent>More actions</TooltipContent>
			</Tooltip>
			<DropdownMenuContent
				align="end"
				// `min-w-[10rem]`, not `min-w-40`: the floor holds action labels, a text measure,
				// and `min-w-40` rides `--spacing`, falling under the primitive's fixed
				// `min-w-[8rem]` (dropdown-menu.tsx) at Default.
				className="min-w-[10rem]"
				onCloseAutoFocus={(e) => {
					focusReturning.current = true;
					queueMicrotask(() => {
						focusReturning.current = false;
					});
					// A field the action opens takes focus; the row must not.
					const handedToField = runDeferred(e);
					// Radix returns focus to the trigger, which in a roving-tabindex tree is not a
					// tab stop, so focus lands on its row, or Escape leaves the tree's one stop
					// where Tab cannot return.
					const row = handedToField
						? null
						: trigger.current?.closest<HTMLElement>('[role="treeitem"]');
					if (row) {
						e.preventDefault();
						row.focus();
					}
					onCloseAutoFocus?.(e);
				}}
			>
				{rowActionRows(actions).map(({ action, separatorBefore }) => (
					<Fragment key={action.label}>
						{separatorBefore && <DropdownMenuSeparator />}
						<DropdownMenuItem
							disabled={action.disabled}
							onSelect={onSelectOf(action)}
							className={rowActionItemClass(action)}
						>
							<RowActionBody action={action} />
						</DropdownMenuItem>
					</Fragment>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
