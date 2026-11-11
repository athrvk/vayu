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
import { createStore, useStore, type StoreApi } from "zustand";
import { useCollectionTreeHandlers } from "./context/CollectionTreeContext";
import type {
	CollectionTreeDragState,
	CollectionTreeDropTarget,
} from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";
import { entityRowKey } from "./tree-rows";
import type { RowAction } from "@/components/shared";
import { rowInsetPx } from "@/constants/layout";

/** The drop line a row draws: which edge, and the left inset it starts at. */
export interface RowDropLine {
	edge: "before" | "after";
	indentPx: number;
}

export interface RowDnd {
	/** This row is the one being dragged. */
	isDragging: boolean;
	/** This row cannot be dropped on: it is inside the dragged folder's subtree. */
	isBlocked: boolean;
	/** The line on this row's edge, for a drop beside this row or above it. */
	dropLine: RowDropLine | null;
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
 * The drop target when it is drawn on the row `rowKey` names, else `null`: the
 * selector answers only for this row, so a crossing re-renders the row the
 * indicator left and the row it arrived on, not the tree (#2543).
 */
function useDropTargetOn(
	dragState: StoreApi<CollectionTreeDragState>,
	rowKey: string
): CollectionTreeDropTarget | null {
	return useStore(dragState, (state) =>
		state.dropTarget?.rowKey === rowKey ? state.dropTarget : null
	);
}

/** The line half of a drop target; the indent is the target's depth, not the row's. */
function lineOf(target: CollectionTreeDropTarget | null): RowDropLine | null {
	if (!target || target.position === "inside") return null;
	return { edge: target.position, indentPx: rowInsetPx(target.depth) };
}

/**
 * The drop line for a row that is not a treeitem - the "Empty collection"
 * line, the new-folder form - which a line after an open folder can sit under.
 */
export function useRowDropLine(rowKey: string): RowDropLine | null {
	const { dnd } = useCollectionTreeHandlers();
	return lineOf(useDropTargetOn(dnd?.dragState ?? IDLE_DRAG_STATE, rowKey));
}

/**
 * A row's drag state, subscribed per fact (#2543): the drop target through
 * `useDropTargetOn`, and `dragging`, which changes twice per drag, so every
 * row reading it is fine.
 */
export function useRowDnd(entity: TreeEntity): RowDnd {
	const { dnd } = useCollectionTreeHandlers();
	const dragState = dnd?.dragState ?? IDLE_DRAG_STATE;
	const dragging = useStore(dragState, (state) => state.dragging);
	const target = useDropTargetOn(dragState, entityRowKey(entity));
	const isBlocked = useMemo(
		() => (dnd && dragging ? dnd.isDropBlocked(dragging, entity) : false),
		[dnd, dragging, entity]
	);

	if (!dnd) {
		return {
			isDragging: false,
			isBlocked: false,
			dropLine: null,
			isDropInto: false,
			moveActions: [],
		};
	}
	return {
		isDragging: dragging?.id === entity.id,
		isBlocked,
		dropLine: lineOf(target),
		isDropInto: target?.position === "inside",
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
