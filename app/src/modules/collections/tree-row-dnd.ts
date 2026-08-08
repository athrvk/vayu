/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drag wiring a tree row needs, in one place for both row types.
 *
 * `CollectionItem` and `RequestItem` are different components with the same
 * drag contract - the same pointer handlers, the same indicator, the same four
 * hidden Alt+Arrow controls - and a second copy of any of it would be a copy
 * that stops receiving the first one's fixes. That is this repo's most repeated
 * defect, so the shared half lives here and each row keeps only what differs:
 * its own indent and its own entity.
 *
 * Everything degrades to nothing when no drag machinery is mounted (`dnd` is
 * `null`), which is what a test rendering one row in isolation gets.
 */

import { useCollectionTreeContext } from "./context/CollectionTreeContext";
import type { CollectionTreeRowHandlers } from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";
import type { RowAction } from "@/components/shared";

export interface RowDnd {
	/** Spread onto the row's own box - the element the gesture is captured on. */
	handlers: Partial<CollectionTreeRowHandlers>;
	/** This row is the one being dragged. */
	isDragging: boolean;
	/** This row cannot be dropped on: it is inside the dragged folder's subtree. */
	isBlocked: boolean;
	/** A drop would land immediately before or after this row. */
	dropEdge: "before" | "after" | null;
	/** A drop would land inside this row (folders only). */
	isDropInto: boolean;
	/** The row menu's "Move to..." entry, or null when nothing is mounted. */
	moveAction: RowAction | null;
}

export function useRowDnd(entity: TreeEntity): RowDnd {
	const { dnd } = useCollectionTreeContext();
	if (!dnd) {
		return {
			handlers: {},
			isDragging: false,
			isBlocked: false,
			dropEdge: null,
			isDropInto: false,
			moveAction: null,
		};
	}
	const target = dnd.dropTarget?.id === entity.id ? dnd.dropTarget.position : null;
	return {
		handlers: dnd.rowHandlers(entity),
		isDragging: dnd.draggingId === entity.id,
		isBlocked: dnd.isDropBlocked(entity),
		dropEdge: target === "inside" ? null : target,
		isDropInto: target === "inside",
		moveAction: dnd.moveAction(entity),
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
