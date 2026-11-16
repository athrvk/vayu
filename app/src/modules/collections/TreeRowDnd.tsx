/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two pieces of drag chrome a tree row renders: the drop line, and the
 * hidden Alt+Arrow controls.
 *
 * Both are shared by `CollectionItem` and `RequestItem` - two components with
 * one drag contract - because a second copy of either is a copy that stops
 * receiving the first one's fixes. The state behind them lives in
 * `tree-row-dnd.ts`; this file is only what renders.
 */

import { DropIndicator } from "@/components/shared";
import { useCollectionTreeHandlers } from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";
import { useRowDropLine, type RowDropLine } from "./tree-row-dnd";

/**
 * The 2px line between two rows.
 *
 * Indented to the depth of the row the drop lands beside rather than drawn
 * edge to edge, because the depth is the only thing that distinguishes "after
 * this collapsed folder", "into it" and "after its parent" - three drops whose
 * lines would otherwise be pixel-identical. That is not always the depth of the
 * row drawing it: a line after an open folder sits under its last visible row,
 * at the folder's indent.
 *
 * A `span` positioned inside the row, not a node between rows: the roving-focus
 * walk reads the row order from the DOM, so an indicator element that sat
 * between treeitems would change the tree's shape mid-drag.
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
 * The four hidden Alt+Arrow targets, the same pattern F2 and Delete already
 * use: the key handler lives in `useRovingTreeFocus` and finds the control by
 * attribute, so no handler has to be threaded through a row's prop list.
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
