/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Right-click on a row, offering its `⋯` menu's actions (#1360). Wrap the row's root element:
 *
 * ```tsx
 * <RowContextMenu label="Actions for Get users" actions={actions}>
 *   <div role="treeitem" ...>…</div>
 * </RowContextMenu>
 * ```
 *
 * **It wraps, not replaces**: `asChild` puts the handlers on the row, adding no element, so a grid
 * or flex child stays one and the drawer's indent maths holds. **The actions are the pointed-at
 * row's, without selecting it**: selecting in the collection tree opens the request in a tab
 * (`selectedRequestId` derives from the active tab, `CollectionTree.tsx`), and no file manager
 * opens a document on right-click. Delete deleting the row under the pointer, not the open one,
 * comes from the actions, each row building its list over its entity. The right-click does move
 * focus to the row, the tree's "you are here". **The native menu is kept away by the marker, not
 * `preventDefault`**: the main process draws its edit menu from Chromium's `context-menu` event
 * (`electron/context-menu.ts`), which a renderer's `preventDefault` does not reach.
 * `contextProps("own-menu")` says a surface draws its own, spread here so every row is covered, as
 * for Monaco.
 */

import { Fragment, type ReactElement } from "react";
import {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "@/components/ui";
import { contextProps } from "@/lib/context-menu";
import { rowActionRows, rowActionItemClass, type RowAction } from "./row-actions";
import { RowActionBody } from "./RowActionBody";
import { useAfterMenuClose } from "./useAfterMenuClose";

interface RowContextMenuProps {
	/** Names the menu for screen readers, e.g. "Actions for Get users". */
	label: string;
	actions: RowAction[];
	/**
	 * Stand down: no menu and no marker, for a row that is momentarily not a row (an inline rename
	 * is open, or it is mid-delete). The marker comes off too: it refuses the main process's edit
	 * menu, so left on, a right-click in the rename field would offer neither Cut/Copy/Paste nor
	 * ours.
	 */
	disabled?: boolean;
	/** The row itself - one element, which becomes the trigger. */
	children: ReactElement;
}

export function RowContextMenu({ label, actions, disabled, children }: RowContextMenuProps) {
	// A row with nothing to offer keeps the platform's behaviour rather than an empty menu. `off`,
	// not an early return of `children`: a wrapper coming and going remounts the row, losing focus
	// and any open field.
	const off = disabled || actions.length === 0;

	return (
		<ContextMenu>
			<ContextMenuTrigger
				asChild
				disabled={off}
				{...(off ? {} : contextProps("own-menu"))}
				onContextMenu={(event) => {
					/*
					 * Focus the row on the way: a right-click moves no focus, so the menu's focus
					 * scope would drop the user on `<body>` on Escape, outside the tree holding its
					 * one tab stop (`RowActionsMenu`'s `onCloseAutoFocus` keeps the same promise).
					 * A row that is not focusable is unmoved. Radix runs this even with the trigger
					 * disabled, hence the guard: a right-click on an open rename field must not
					 * take its focus.
					 */
					if (!off) event.currentTarget.focus();
				}}
			>
				{children}
			</ContextMenuTrigger>
			<RowContextMenuContent label={label} actions={actions} />
		</ContextMenu>
	);
}

/**
 * The menu's items, for a `ContextMenu` whose trigger is not one row: the collection tree opens one
 * menu for every row and resolves the row from the click (#2543). One drawing of the list, so the
 * two cannot drift.
 */
export function RowContextMenuContent({ label, actions }: { label: string; actions: RowAction[] }) {
	const { onSelectOf, runDeferred } = useAfterMenuClose();

	return (
		// `min-w-[10rem]`, not `min-w-40`: the floor holds action labels, a text measure, and
		// `min-w-40` rides `--spacing`, falling under the primitive's fixed `min-w-[8rem]`
		// (context-menu.tsx) at Default.
		<ContextMenuContent
			aria-label={label}
			className="min-w-[10rem]"
			// Radix would return focus to the row, taking it from a field an action opened
			// (`useAfterMenuClose`, #3443).
			onCloseAutoFocus={runDeferred}
		>
			{rowActionRows(actions).map(({ action, separatorBefore }) => (
				<Fragment key={action.label}>
					{separatorBefore && <ContextMenuSeparator />}
					<ContextMenuItem
						disabled={action.disabled}
						onSelect={onSelectOf(action)}
						className={rowActionItemClass(action)}
					>
						<RowActionBody action={action} />
					</ContextMenuItem>
				</Fragment>
			))}
		</ContextMenuContent>
	);
}
