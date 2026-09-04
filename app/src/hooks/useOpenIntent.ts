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
import { dispatchChord } from "@/lib/editor-chords";
import { NEW_REQUEST_CHORD } from "@/constants/shortcuts";

export function useOpenIntent(): void {
	useEffect(() => {
		// Optional-chain the call too: an older preload build exposes no such
		// method, and `?.` on electronAPI alone would not guard that.
		return window.electronAPI?.onOpenIntent?.((intent) => {
			if (intent.kind === "newRequest") {
				// Re-dispatched to the one window handler rather than called a
				// second way, which is what `editor-chords.ts` exists for and the
				// same reasoning `useNotificationActivation` gives for settings.
				//
				// It cannot go through `commandById("new-request")` the way that
				// hook goes through `open-settings`: the command is declared
				// `available: (ctx) => ctx.surfaces !== undefined`, because the
				// flow can need a collection picker and a picker needs a mounted
				// host to render it. `baseCommandContext()` has no `surfaces` by
				// design, so `perform` there is `ctx.surfaces?.newRequest()` - a
				// silent no-op, and a Dock menu entry that opens nothing.
				// `Shell` owns the chord, the picker and the no-collections case;
				// this hands it the keypress and lets it keep all three.
				dispatchChord(NEW_REQUEST_CHORD);
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
