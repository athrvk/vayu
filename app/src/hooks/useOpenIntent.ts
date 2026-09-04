/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Something the OS asked Vayu to open, forwarded from `electron/open-intent.ts`
 * (issue #1364): a document dropped on the icon, a collection picked off the
 * Dock menu or a Jump List task, or New Request from either.
 *
 * Mounted once, in `App`, for the reason `useNotificationActivation` is: the
 * listener is on the preload bridge, and a second mount would act on one OS
 * request twice.
 */

import { useEffect } from "react";
import { useImportModalStore, useTabsStore } from "@/stores";
import { baseCommandContext, commandById } from "@/lib/commands";

export function useOpenIntent(): void {
	useEffect(() => {
		// Optional-chain the call too: an older preload build exposes no such
		// method, and `?.` on electronAPI alone would not guard that.
		return window.electronAPI?.onOpenIntent?.((intent) => {
			if (intent.kind === "newRequest") {
				// Through the command, not a second way to open a request - the
				// same reasoning `useNotificationActivation` gives for settings.
				commandById("new-request").perform(baseCommandContext());
				return;
			}
			if (intent.kind === "collection") {
				useTabsStore
					.getState()
					.openTab({ type: "collection", entityId: intent.collectionId });
				return;
			}
			// `import`: the path only. The renderer reads the bytes back through
			// the gated `readSpecFile` channel that already exists - see
			// `ImportModal`'s pending-path effect.
			useImportModalStore.getState().openWithFile(intent.path);
		});
	}, []);
}
