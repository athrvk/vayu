/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect, type RefObject } from "react";
import { useRemovalRefocus } from "@/hooks/useRemovalRefocus";
import { focusTreeRow, rowAfterRemoving } from "./tree-focus";
import type { DeleteConfirmTarget } from "./useTreeCrud";

/**
 * Where focus goes after a row is deleted from the tree.
 *
 * The tree's half of `useRemovalRefocus`, which holds the timing and the rule:
 * this names the rows and how the tree moves focus onto one. Cancel and a
 * failed delete both leave focus on the row it was invoked from, because both
 * leave that row on screen; a delete that actually removes it moves focus to
 * the successor, whenever the removal lands.
 *
 * `rowAfterRemoving` runs while the row is still mounted - once it is gone,
 * "the row after the one that was there" is not a question the DOM can answer.
 */
export function useDeleteRefocus(
	treeRef: RefObject<HTMLElement | null>,
	deleteConfirm: DeleteConfirmTarget | null
) {
	const { capture, onCloseAutoFocus } = useRemovalRefocus();

	useEffect(() => {
		if (!deleteConfirm) return;
		const tree = treeRef.current;
		const attribute =
			deleteConfirm.type === "collection" ? "data-collection-id" : "data-request-id";
		const selector = `[${attribute}="${CSS.escape(deleteConfirm.id)}"]`;
		const doomed = tree?.querySelector<HTMLElement>(selector) ?? null;
		const successor = doomed ? rowAfterRemoving(tree, doomed) : null;

		capture({
			// Re-queried rather than held: a refetch can replace the element while
			// the dialog is up, and the id is what identifies the row.
			doomed: () => tree?.querySelector<HTMLElement>(selector) ?? null,
			successor: () => (successor?.isConnected ? successor : null),
			focus: (row) => focusTreeRow(tree, row),
		});
	}, [capture, deleteConfirm, treeRef]);

	return { onCloseAutoFocus };
}
