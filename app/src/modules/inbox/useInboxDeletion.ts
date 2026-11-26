/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Deleting an inbox (#553), for both surfaces that offer it (the drawer row and the tab), which
 * must agree on when the confirmation appears and what it says is about to be lost. One copy,
 * because two copies of a destructive rule drift towards the one that forgot to ask.
 */

import { useState } from "react";
import { useDeleteInboxMutation } from "@/queries";
import { useToastStore } from "@/stores";
import type { Inbox } from "@/types";

/**
 * How many captures deleting @p inbox would destroy. The record's count is up to one services poll
 * (10s) old, while a surface holding the capture list has the live stream's arrivals merged in, so
 * the higher of the two has seen the newest capture. The record alone would let the tab silently
 * destroy a capture it is displaying, the case the confirmation exists for.
 */
export function capturesAtRisk(inbox: Inbox, listedTotal?: number): number {
	return Math.max(inbox.captureCount, listedTotal ?? 0);
}

export interface InboxDeletion {
	/** The inbox being deleted - what the dialog words itself from. */
	inbox: Inbox;
	captureCount: number;
	/** Deletes an empty inbox outright; opens the confirmation when it holds captures. */
	requestDelete: () => void;
	confirmOpen: boolean;
	closeConfirm: () => void;
	confirmDelete: () => void;
	isDeleting: boolean;
}

/**
 * @param listedTotal the capture total a surface holding the list already
 *        knows, fresher than the record's own count. Omitted by the drawer,
 *        which has no list.
 */
export function useInboxDeletion(inbox: Inbox, listedTotal?: number): InboxDeletion {
	const showToast = useToastStore((s) => s.showToast);
	const deleteInbox = useDeleteInboxMutation();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const captureCount = capturesAtRisk(inbox, listedTotal);

	const run = () =>
		deleteInbox.mutate(inbox.inboxId, {
			onSuccess: () => setConfirmOpen(false),
			onError: (error) => {
				// Closed on failure too: the dialog has said all it can, and the
				// toast carries the reason. Leaving it open invites a retry of
				// the same call that just refused.
				setConfirmOpen(false);
				showToast(
					error instanceof Error
						? `Couldn't delete the inbox - ${error.message}`
						: "Couldn't delete the inbox",
					"error"
				);
			},
		});

	return {
		inbox,
		captureCount,
		// An empty inbox has nothing to lose, so asking is pure friction - and
		// an inbox nobody has sent anything to is exactly the one most likely to
		// be deleted.
		requestDelete: () => (captureCount > 0 ? setConfirmOpen(true) : run()),
		confirmOpen,
		closeConfirm: () => setConfirmOpen(false),
		confirmDelete: run,
		isDeleting: deleteInbox.isPending,
	};
}
