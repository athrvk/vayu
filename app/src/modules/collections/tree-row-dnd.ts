/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag state a tree row draws, in one place for both row types.
 *
 * `CollectionItem` and `RequestItem` are different components with the same
 * drag contract - the same indicator, the same four hidden Alt+Arrow controls -
 * and a second copy of any of it would be a copy that stops receiving the first
 * one's fixes. That is this repo's most repeated defect, so the shared half
 * lives here and each row keeps only what differs: its own indent and its own
 * entity. The pointer handlers are not a row's at all: the tree takes every
 * press on its own element and resolves the row from it (`useTreeDnd`).
 *
 * Everything degrades to nothing when no drag machinery is mounted (`dnd` is
 * `null`), which is what a test rendering one row in isolation gets.
 */

import { useMemo } from "react";
import { createStore, useStore } from "zustand";
import { useCollectionTreeHandlers } from "./context/CollectionTreeContext";
import type { CollectionTreeDragState } from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";
import { entityRowKey } from "./tree-rows";
import type { RowAction } from "@/components/shared";

export interface RowDnd {
	/** This row is the one being dragged. */
	isDragging: boolean;
	/** This row cannot be dropped on: it is inside the dragged folder's subtree. */
	isBlocked: boolean;
	/** A drop would land immediately before or after this row. */
	dropEdge: "before" | "after" | null;
	/** A drop would land inside this row (folders only). */
	isDropInto: boolean;
	/** The row menu's move entries, empty when no drag machinery is mounted. */
	moveActions: RowAction[];
}

/** What a row without drag machinery subscribes to: a drag that never starts. */
const IDLE_DRAG_STATE = createStore<CollectionTreeDragState>(() => ({
	dragging: null,
	dropTarget: null,
}));

/**
 * A row's drag state, subscribed per fact (#2543). The drop target changes on
 * every row the pointer crosses, so it is read through a selector that answers
 * only for this row: a crossing re-renders the row the line left and the row it
 * arrived on, not the tree. `dragging` changes twice per drag, so every row
 * reading it is fine.
 */
export function useRowDnd(entity: TreeEntity): RowDnd {
	const { dnd } = useCollectionTreeHandlers();
	const dragState = dnd?.dragState ?? IDLE_DRAG_STATE;
	const dragging = useStore(dragState, (state) => state.dragging);
	const target = useStore(dragState, (state) =>
		state.dropTarget?.id === entity.id ? state.dropTarget.position : null
	);
	const isBlocked = useMemo(
		() => (dnd && dragging ? dnd.isDropBlocked(dragging, entity) : false),
		[dnd, dragging, entity]
	);

	if (!dnd) {
		return {
			isDragging: false,
			isBlocked: false,
			dropEdge: null,
			isDropInto: false,
			moveActions: [],
		};
	}
	return {
		isDragging: dragging?.id === entity.id,
		isBlocked,
		dropEdge: target === "inside" ? null : target,
		isDropInto: target === "inside",
		moveActions: dnd.moveActions(entity),
	};
}

/** The row's own classes while it is a drag source, a drop target, or refused. */
export function rowDndClasses(row: RowDnd): string {
	return [
		"relative",
		row.isDragging && "opacity-50",
		row.isBlocked && "opacity-40",
		row.isDropInto && "ring-1 ring-inset ring-primary/50 bg-primary/10",
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * The key of the row being dragged, which stays mounted while the drawer
 * auto-scrolls away from it (#2543), so the source keeps its place and its
 * dimmed state for the whole gesture rather than remounting as the drawer
 * passes it. The gesture itself does not depend on it: the pointer is captured
 * on the tree. A string, so the list re-renders when a drag starts or ends and
 * not on every pointer move.
 */
export function useDraggingRowKey(): string | null {
	const { dnd } = useCollectionTreeHandlers();
	return useStore(dnd?.dragState ?? IDLE_DRAG_STATE, ({ dragging }) =>
		dragging ? entityRowKey(dragging) : null
	);
}
