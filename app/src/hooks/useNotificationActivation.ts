/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A system notification was clicked (issue #1358).
 *
 * The main process has already brought the window back; what it cannot do is
 * open what the notification was about, because the app's surfaces are the
 * renderer's own. So it echoes the target the renderer sent with the
 * notification, and this opens it.
 *
 * Mounted once, in `App`, for the reason `useMenuActions` is: the listener is
 * on the preload bridge, and a second mount would open two tabs per click.
 */

import { useEffect } from "react";
import { useTabsStore } from "@/stores";
import { baseCommandContext, commandById } from "@/lib/commands";

export function useNotificationActivation(): void {
	useEffect(() => {
		// Optional-chain the call too: an older preload build exposes no such
		// method, and `?.` on electronAPI alone would not guard that.
		return window.electronAPI?.onNotificationActivated?.(({ target }) => {
			if (target.view === "run") {
				useTabsStore.getState().openTab({ type: "run", entityId: target.runId });
				return;
			}
			if (target.view === "settings") {
				// Through the command, not two lines of its own: the palette, the
				// Preferences… menu item and this must not drift into opening
				// settings differently.
				commandById("open-settings").perform(baseCommandContext());
				return;
			}
			// `app`: the window coming back is the whole of it. A notification
			// about something with no place to open - a sign-in that finished
			// where the user already was - moves nobody.
		});
	}, []);
}
