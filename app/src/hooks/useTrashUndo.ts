/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback } from "react";
import { useRestoreTrashMutation } from "@/queries";
import { useToastStore } from "@/stores";
import { restoreNotice } from "@/modules/trash";
import type { TrashEntry } from "@/types";

/**
 * Raise the toast a soft delete offers: "Moved "<name>" to the Trash" with an
 * Undo that restores the row.
 *
 * Lives here rather than beside one of its callers because two modules delete
 * into the Trash - the collection tree (`useTreeCrud`) and the Variables view's
 * environment deletes (#2970) - and a second, hand-rolled toast would not
 * receive this one's fixes. `restoreClientState` is whatever the caller threw
 * away on the client and wants back once the engine has restored the row; it
 * runs only after a restore that landed.
 */
export function useTrashUndo() {
	const restoreTrashMutation = useRestoreTrashMutation();
	const showToast = useToastStore((s) => s.showToast);

	/**
	 * Take the delete back.
	 *
	 * The engine's delete is soft (issue #988), so this is a restore of the row
	 * that was just stamped - not a re-creation - and the whole subtree a
	 * collection's delete took comes back with it.
	 *
	 * The failure path is the reason this is not a bare `mutateAsync`. Undo can
	 * genuinely fail: the toast outlives its own click by design, and by then
	 * the item's parent collection may itself have been deleted (a 409 naming
	 * it) or the retention purge may have swept it (a 404). The engine's message
	 * says which and what to do next, so it is surfaced as it stands - an undo
	 * that silently does nothing is the one outcome worse than no undo.
	 */
	const undoDelete = useCallback(
		async (entityId: string, name: string, restoreClientState: () => void) => {
			try {
				const restored = await restoreTrashMutation.mutateAsync(entityId);
				// Only after the engine has actually put the rows back: reopening
				// a tab for a request the restore refused would be a pane pointed
				// at a row that is still in the trash.
				restoreClientState();
				/*
				 * An undo can put the folder back somewhere new: if its parent
				 * went to the trash too while this toast was up - and the
				 * "never" duration setting keeps a toast up until it is
				 * dismissed - the engine restores it as a tree root. Same
				 * sentence the Trash view's Restore raises, from the same
				 * function, because a field one caller reads and the other
				 * drops is how the two answers drift apart.
				 */
				const notice = restoreNotice(restored, name);
				if (notice) showToast({ message: notice, variant: "info" });
			} catch (error) {
				const fallback = `Couldn't restore "${name}"`;
				showToast(
					error instanceof Error ? `${fallback} - ${error.message}` : fallback,
					"error"
				);
			}
		},
		[restoreTrashMutation, showToast]
	);

	/**
	 * Say where it went, and offer it straight back.
	 *
	 * No explicit duration: the toast takes the `info` default, scaled by the
	 * user's own notification setting, exactly as the tree's drag-and-drop undo
	 * does. A longer hardcoded window would override a preference the user
	 * set - including "never", which means "wait for me" - and it would be
	 * buying something the feature already has: this toast is the fast path, and
	 * the Trash view is the same undo with the retention window behind it, so a
	 * missed toast costs a click rather than the data.
	 *
	 * The undo itself is offered no undo. Deleting it again is one click away in
	 * the view it just came back to.
	 */
	return useCallback(
		(
			entityId: string,
			name: string,
			kind: TrashEntry["kind"],
			restoreClientState: () => void = () => {}
		) => {
			showToast({
				message: `Moved "${name}" to the Trash`,
				variant: "info",
				action: {
					label: "Undo",
					altText: `Undo deleting the ${kind} ${name}`,
					onClick: () => void undoDelete(entityId, name, restoreClientState),
				},
			});
		},
		[showToast, undoDelete]
	);
}
