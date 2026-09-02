/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { focusTreeRow, rowAfterRemoving } from "./tree-focus";
import type { DeleteConfirmTarget } from "./useTreeCrud";

/**
 * Where focus goes after a row is deleted from the tree.
 *
 * Radix aims its close-focus at the dialog's trigger, and this dialog is
 * rendered controlled with none - so focus fell to `<body>` and the next Tab
 * restarted from the top of the document (#1218), on Cancel as much as on
 * Delete. The tree already refuses to strand focus after a rename or a row menu
 * closing; its one destructive action still did.
 *
 * Cancel is the easy half: the row is still there, so focus goes back to it.
 * After a delete the row is the thing that went, so a successor is chosen while
 * it is still on screen - once the dialog closes, "the row after the one that
 * was there" is not a question the DOM can answer any more.
 */
export function useDeleteRefocus(
	treeRef: RefObject<HTMLElement | null>,
	deleteConfirm: DeleteConfirmTarget | null
) {
	const row = useRef<HTMLElement | null>(null);
	const successor = useRef<HTMLElement | null>(null);
	const confirmed = useRef(false);

	useEffect(() => {
		if (!deleteConfirm) return;
		confirmed.current = false;
		const attribute =
			deleteConfirm.type === "collection" ? "data-collection-id" : "data-request-id";
		const doomed = treeRef.current?.querySelector<HTMLElement>(
			`[${attribute}="${CSS.escape(deleteConfirm.id)}"]`
		);
		row.current = doomed ?? null;
		successor.current = doomed ? rowAfterRemoving(treeRef.current, doomed) : null;
	}, [deleteConfirm, treeRef]);

	/** Called on the way into the deletion, not after it: the dialog closes on
	 * both outcomes and nothing in its close tells the two apart. */
	const markConfirmed = useCallback(() => {
		confirmed.current = true;
	}, []);

	const onCloseAutoFocus = useCallback(
		(event: Event) => {
			const target = confirmed.current ? successor.current : row.current;
			row.current = null;
			successor.current = null;
			// Only onto a row that is still there: a failed delete leaves the tree
			// as it was, and a refetch can replace the element under either ref.
			if (!target?.isConnected) return;
			event.preventDefault();
			focusTreeRow(treeRef.current, target);
		},
		[treeRef]
	);

	return { markConfirmed, onCloseAutoFocus };
}
