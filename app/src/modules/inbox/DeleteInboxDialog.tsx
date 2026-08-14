/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { DeleteConfirmDialog } from "@/components/ui";
import type { InboxDeletion } from "./useInboxDeletion";

/**
 * The confirmation both delete affordances raise (issue #553).
 *
 * It names the count because that is the whole of what is at stake: the
 * listener is replaceable in one click, the recorded requests are not. Renders
 * nothing until the deletion asks for it - an inbox holding nothing is deleted
 * outright, so this dialog only ever appears over something worth losing.
 */
export function DeleteInboxDialog({ deletion }: { deletion: InboxDeletion }) {
	const { inbox, captureCount } = deletion;
	return (
		<DeleteConfirmDialog
			open={deletion.confirmOpen}
			onOpenChange={deletion.closeConfirm}
			title={`Delete the inbox on port ${inbox.port}?`}
			description={`Its ${captureCount} recorded ${
				captureCount === 1 ? "request" : "requests"
			} will be deleted with it. This cannot be undone.`}
			onConfirm={deletion.confirmDelete}
			isDeleting={deletion.isDeleting}
		/>
	);
}
