/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, type ReactElement } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui";
import { RowContextMenuContent } from "@/components/shared";
import { useCopy } from "@/hooks/useCopy";
import { useCollectionTreeHandlers, useCollectionTreeState } from "./context/CollectionTreeContext";
import { TREE_ITEM } from "./tree-focus";
import { treeRowMenu } from "./tree-row-menu";
import type { TreeRow } from "./tree-rows";

interface CollectionTreeContextMenuProps {
	/** The row of the flat list an element sits in (`TreeRowWindow.rowOf`). */
	rowAt: (element: Element) => TreeRow | null;
	/** The `role="tree"` element, which becomes the one trigger. */
	children: ReactElement;
}

/**
 * Right-click on a collection tree row (#1360), as one menu for the whole tree
 * (#2543) rather than a `RowContextMenu` per row: the row is resolved from the
 * click and its actions built from the flat rows model, the same builders the
 * row's `⋯` menu uses (`tree-row-menu.ts`).
 *
 * What a right-click does is `RowContextMenu`'s, row for row: it focuses the
 * row so Escape has somewhere of ours to return to, it does not select it, and
 * a row mid-rename or mid-delete opens nothing. The `own-menu` marker that keeps
 * the main process's menu away stays on each row, which is where
 * `electron/context-menu.ts` reads it from the click's own target.
 */
export function CollectionTreeContextMenu({ rowAt, children }: CollectionTreeContextMenuProps) {
	const state = useCollectionTreeState();
	const handlers = useCollectionTreeHandlers();
	const { copy } = useCopy();
	const [row, setRow] = useState<TreeRow | null>(null);
	const [open, setOpen] = useState(false);

	// Built from the current state, not the state of the click: a row that
	// starts a rename or a delete while its menu is open closes it.
	const menu = row ? treeRowMenu(row, state, handlers, copy) : null;
	// And stays closed, rather than coming back when the row is free again.
	if (open && menu === null) setOpen(false);

	/*
	 * Capture, so the decision is made before the trigger's own handler, which
	 * opens and calls `preventDefault`. A click with no menu under it - a
	 * spacer, the "Empty collection" line, the new-folder field, a busy row's
	 * rename field - is stopped short of that handler instead, so the platform
	 * keeps its default: the rename field its Cut/Copy/Paste. Stopping here
	 * costs nothing else, since the one other listener (`installContextMenuBridge`)
	 * captures on `window`, ahead of this.
	 */
	const onContextMenuCapture = (event: React.MouseEvent<HTMLElement>) => {
		const target = event.target instanceof Element ? event.target : null;
		const pointed = target ? rowAt(target) : null;
		const hasMenu = pointed !== null && treeRowMenu(pointed, state, handlers, copy) !== null;
		// Cleared as well as set: a touch long-press opens on Radix's own timer
		// as well as on this event, and must not open the last row's menu.
		setRow(hasMenu ? pointed : null);
		if (!hasMenu) {
			event.stopPropagation();
			return;
		}
		target?.closest<HTMLElement>(TREE_ITEM)?.focus();
	};

	return (
		<ContextMenu open={open && menu !== null} onOpenChange={setOpen}>
			<ContextMenuTrigger asChild onContextMenuCapture={onContextMenuCapture}>
				{children}
			</ContextMenuTrigger>
			{menu && <RowContextMenuContent label={menu.label} actions={menu.actions} />}
		</ContextMenu>
	);
}
