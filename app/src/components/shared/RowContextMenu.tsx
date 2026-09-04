/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RowContextMenu
 *
 * Right-click on a row, offering the same actions its `⋯` menu offers (#1360).
 * Wrap the row's own root element:
 *
 * ```tsx
 * <RowContextMenu label="Actions for Get users" actions={actions}>
 *   <div role="treeitem" ...>…</div>
 * </RowContextMenu>
 * ```
 *
 * **It wraps rather than replaces.** `asChild` puts the trigger's handlers on
 * the row itself, so no element is added to the tree - a row that is a grid or
 * flex child of its container stays one, and the drawer's indent maths is
 * untouched.
 *
 * **The actions are the pointed-at row's, without selecting it.** What "select"
 * would mean in the collection tree is opening the request in a tab
 * (`selectedRequestId` is derived from the active tab, `CollectionTree.tsx`),
 * and no file manager opens a document because you right-clicked it. The
 * property that needs guaranteeing - that Delete deletes the row under the
 * pointer and not the one that happens to be open - comes from the actions
 * themselves: each row builds its own list over its own entity. What the
 * right-click does move is focus, to the row it opened over, which is the
 * tree's own "you are here".
 *
 * **The native menu is kept away by the marker, not by `preventDefault`.** The
 * main process draws its edit menu from Chromium's own `context-menu` event on
 * the web contents (`electron/context-menu.ts`), which a renderer's
 * `preventDefault` does not reach. `contextProps("own-menu")` is what says a
 * surface draws its own, and it is spread here so every row that takes this
 * component is covered without spelling it out again - the same arrangement
 * Monaco already had.
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

interface RowContextMenuProps {
	/** Names the menu for screen readers, e.g. "Actions for Get users". */
	label: string;
	actions: RowAction[];
	/**
	 * Stand down: no menu, and no marker either.
	 *
	 * For the moments a row is not a row - an inline rename field is open in
	 * it, or it is mid-delete. The marker has to come off with the menu,
	 * because it is what refuses the main process's edit menu: left on, a
	 * right-click inside the rename field would offer neither Cut/Copy/Paste
	 * nor anything of ours.
	 */
	disabled?: boolean;
	/** The row itself - one element, which becomes the trigger. */
	children: ReactElement;
}

export function RowContextMenu({ label, actions, disabled, children }: RowContextMenuProps) {
	// A row with nothing to offer keeps the platform's own behaviour rather than
	// swallowing the gesture into an empty menu. Stated as `off` rather than an
	// early return of `children`: a wrapper that comes and goes remounts the row
	// under it, which loses focus and any field open inside it.
	const off = disabled || actions.length === 0;

	return (
		<ContextMenu>
			<ContextMenuTrigger
				asChild
				disabled={off}
				{...(off ? {} : contextProps("own-menu"))}
				onContextMenu={(event) => {
					/*
					 * Focus the row on the way past. A right-click does not move
					 * focus on its own, so without this the menu's focus scope
					 * has nowhere of ours to return to on Escape and drops the
					 * user on `<body>` - outside the tree that was holding its
					 * one tab stop. The `⋯` menu makes the same promise from the
					 * other direction (`RowActionsMenu`'s `onCloseAutoFocus`).
					 * A row that is not focusable is unmoved by this.
					 *
					 * Radix runs this handler even when the trigger is disabled,
					 * so the guard is here: a right-click on an open rename field
					 * must not pull focus out of it.
					 */
					if (!off) event.currentTarget.focus();
				}}
			>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent aria-label={label} className="min-w-40">
				{rowActionRows(actions).map(({ action, separatorBefore }) => (
					<Fragment key={action.label}>
						{separatorBefore && <ContextMenuSeparator />}
						<ContextMenuItem
							disabled={action.disabled}
							onSelect={action.onSelect}
							className={rowActionItemClass(action)}
						>
							<RowActionBody action={action} />
						</ContextMenuItem>
					</Fragment>
				))}
			</ContextMenuContent>
		</ContextMenu>
	);
}
