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

import { useCollectionTreeContext } from "./context/CollectionTreeContext";
import type { TreeEntity } from "./drop-position";

/**
 * The 2px line between two rows.
 *
 * Indented to the target row's own depth rather than drawn edge to edge,
 * because the depth is the only thing that distinguishes "after this collapsed
 * folder", "into it" and "after its parent" - three drops whose lines would
 * otherwise be pixel-identical.
 *
 * A `span` positioned inside the row, not a node between rows: the roving-focus
 * walk and the group nesting are derived from the DOM, so an indicator element
 * that sat between treeitems would change the tree's shape mid-drag.
 */
export function RowDropIndicator({
	edge,
	indentPx,
}: {
	edge: "before" | "after" | null;
	indentPx: number;
}) {
	if (!edge) return null;
	return (
		<span
			aria-hidden="true"
			data-drop-indicator={edge}
			className={`pointer-events-none absolute right-2 h-0.5 bg-primary ${
				edge === "before" ? "top-0" : "bottom-0"
			}`}
			style={{ left: indentPx }}
		/>
	);
}

/**
 * The four hidden Alt+Arrow targets, the same pattern F2 and Delete already
 * use: the key handler lives in `useRovingTreeFocus` and finds the control by
 * attribute, so no handler has to be threaded through a row's prop list.
 */
export function RowMoveControls({ entity }: { entity: TreeEntity }) {
	const { dnd } = useCollectionTreeContext();
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
