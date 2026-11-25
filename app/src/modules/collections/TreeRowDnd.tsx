/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two pieces of drag chrome a tree row renders: the drop line and the hidden Alt+Arrow
 * controls. Shared by `CollectionItem` and `RequestItem` (one drag contract), as a second copy of
 * either stops receiving the first one's fixes. The state lives in `tree-row-dnd.ts`; this file
 * only renders.
 */

import { DropIndicator } from "@/components/shared";
import { useCollectionTreeHandlers } from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";
import { useRowDropLine, type RowDropLine } from "./tree-row-dnd";

/**
 * The 2px line between two rows, indented to the depth of the row the drop lands beside rather than
 * drawn edge to edge: depth alone distinguishes "after this collapsed folder", "into it" and "after
 * its parent", three otherwise pixel-identical lines. That is not always the drawing row's depth: a
 * line after an open folder sits under its last visible row, at the folder's indent.
 *
 * A `span` inside the row, not a node between rows: the roving-focus walk reads the row order from
 * the DOM, so an element between treeitems would change the tree's shape mid-drag.
 */
export function RowDropIndicator({ line }: { line: RowDropLine | null }) {
	if (!line) return null;
	return <DropIndicator edge={line.edge} orientation="horizontal" indentPx={line.indentPx} />;
}

/** The same line, for a row with no `useRowDnd` of its own; the host must be `relative`. */
export function RowDropIndicatorFor({ rowKey }: { rowKey: string }) {
	return <RowDropIndicator line={useRowDropLine(rowKey)} />;
}

/**
 * The four hidden Alt+Arrow targets, F2's and Delete's pattern: `useRovingTreeFocus` finds the
 * control by attribute, so no handler is threaded through a row's props.
 */
export function RowMoveControls({ entity }: { entity: TreeEntity }) {
	const { dnd } = useCollectionTreeHandlers();
	if (!dnd) return null;
	return (
		<>
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-move-up
				onClick={() => dnd.moveByKeyboard(entity, "up")}
			/>
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-move-down
				onClick={() => dnd.moveByKeyboard(entity, "down")}
			/>
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-move-in
				onClick={() => dnd.moveByKeyboard(entity, "in")}
			/>
			<button
				type="button"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-tree-move-out
				onClick={() => dnd.moveByKeyboard(entity, "out")}
			/>
		</>
	);
}
