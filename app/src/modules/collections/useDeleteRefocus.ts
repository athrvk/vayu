/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, type RefObject } from "react";
import { useRemovalRefocus } from "@/hooks/useRemovalRefocus";
import { TREE_ITEM, focusTreeRow, rowAfterRemoving } from "./tree-focus";

/**
 * Where focus goes after a row is deleted from a tree: the tree's half of `useRemovalRefocus`,
 * which holds the timing and the rule, while this names the rows and how the tree moves focus onto
 * one. Cancel and a failed delete leave focus on the row it was invoked from, as both leave that
 * row on screen; a delete that removes it moves focus to the successor, whenever the removal lands.
 * `rowAfterRemoving` runs while the row is still mounted: once it is gone, the DOM cannot say which
 * row followed it.
 *
 * Shared by both trees that can delete a row (the collection tree, and the variables sidebar with
 * its keyboard Delete, #1217): a per-tree copy of a timing rule is the copy that drifts. What
 * differs is which attribute identifies a row and where an emptied tree hands focus, so those are
 * the parameters.
 *
 * @param doomedSelector matches the row the pending delete would remove, `null` when none is
 *        pending. The caller spells it: only it knows which attribute carries its ids.
 * @param lastResort where focus goes when the tree can name no successor (the deleted row was the
 *        only one left). `null` says the tree cannot reach that state, the answer for a tree whose
 *        rows all sit under a section header that survives them.
 */
export function useDeleteRefocus(
	treeRef: RefObject<HTMLElement | null>,
	doomedSelector: string | null,
	lastResort: RefObject<HTMLElement | null> | null
) {
	const { capture, onCloseAutoFocus, awaitRemoval } = useRemovalRefocus();

	useEffect(() => {
		if (!doomedSelector) return;
		const tree = treeRef.current;
		const doomed = tree?.querySelector<HTMLElement>(doomedSelector) ?? null;
		const successor = doomed ? rowAfterRemoving(tree, doomed) : null;

		capture({
			// Re-queried rather than held: a refetch can replace the element while
			// the dialog is up, and the id is what identifies the row.
			doomed: () => tree?.querySelector<HTMLElement>(doomedSelector) ?? null,
			// A successor that went with the row it followed is no more usable than
			// no successor at all, so both end on the last resort.
			successor: () => (successor?.isConnected ? successor : (lastResort?.current ?? null)),
			// The last resort is not a row, and moving the tree's one tab stop onto it would take
			// the stop off the tree entirely, so only a row goes through `focusTreeRow`.
			focus: (element) =>
				element.matches(TREE_ITEM) ? focusTreeRow(tree, element) : element.focus(),
		});
	}, [capture, doomedSelector, lastResort, treeRef]);

	return { onCloseAutoFocus, awaitRemoval };
}
