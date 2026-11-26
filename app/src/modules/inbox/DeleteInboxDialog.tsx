/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { DeleteConfirmDialog } from "@/components/ui";
import { pickByCount } from "@/modules/dashboard/utils/format";
import type { InboxDeletion } from "./useInboxDeletion";

/**
 * The confirmation both delete affordances raise (#553). It names the count because that is what is
 * at stake: the listener is replaceable in one click, the recorded requests are not. Renders
 * nothing until a deletion asks for it: an empty inbox is deleted outright, so this only appears
 * over something worth losing.
 */
export function DeleteInboxDialog({ deletion }: { deletion: InboxDeletion }) {
	const { inbox, captureCount } = deletion;
	const consequence =
		captureCount === 0
			? "It has no recorded requests."
			: pickByCount(captureCount, {
					one: "Its one recorded request is removed with it.",
					other: `Its ${captureCount} recorded requests are removed with it.`,
				});
	return (
		<DeleteConfirmDialog
			open={deletion.confirmOpen}
			onOpenChange={deletion.closeConfirm}
			title={`Delete the inbox on port ${inbox.port}?`}
			confirmLabel="Delete inbox"
			description={`${consequence} This can't be undone.`}
			onConfirm={deletion.confirmDelete}
			isDeleting={deletion.isDeleting}
		/>
	);
}
