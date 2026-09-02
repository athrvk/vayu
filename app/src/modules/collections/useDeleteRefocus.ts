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
 * Where focus goes after a row is deleted from a tree.
 *
 * The tree's half of `useRemovalRefocus`, which holds the timing and the rule:
 * this names the rows and how the tree moves focus onto one. Cancel and a
 * failed delete both leave focus on the row it was invoked from, because both
 * leave that row on screen; a delete that actually removes it moves focus to
 * the successor, whenever the removal lands.
 *
 * `rowAfterRemoving` runs while the row is still mounted - once it is gone,
 * "the row after the one that was there" is not a question the DOM can answer.
 *
 * Shared by both trees that can delete a row, rather than re-wired per tree:
 * the variables sidebar acquired a keyboard Delete in #1217, after this was
 * written, and hand-rolling its own would have been the third copy of a timing
 * rule this repo has already watched drift twice. What differs between them is
 * which attribute identifies a row and where an emptied tree hands focus, so
 * those are the parameters.
 *
 * @param doomedSelector matches the row the open dialog would remove, `null`
 *   when no dialog is open. The caller spells it, because only the caller knows
 *   which attribute carries its ids.
 * @param lastResort where focus goes when the tree can name no successor at all
 *   - the row deleted was the only one left. `null` says the tree cannot reach
 *   that state, which is the answer for a tree whose rows all sit under a
 *   section header that survives them.
 */
export function useDeleteRefocus(
	treeRef: RefObject<HTMLElement | null>,
	doomedSelector: string | null,
	lastResort: RefObject<HTMLElement | null> | null
) {
	const { capture, onCloseAutoFocus } = useRemovalRefocus();

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
			// The last resort is not a row, and moving the tree's one tab stop onto
			// it would take that stop off the tree entirely - so only a row travels
			// through `focusTreeRow`.
			focus: (element) =>
				element.matches(TREE_ITEM) ? focusTreeRow(tree, element) : element.focus(),
		});
	}, [capture, doomedSelector, lastResort, treeRef]);

	return { onCloseAutoFocus };
}
