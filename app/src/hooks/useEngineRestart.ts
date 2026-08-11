/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Restarting the engine, from wherever the user is standing.
 *
 * Two places offer the action - the Settings banner beside the setting that
 * asked for it, and the Dock, which is on screen when Settings is not - and the
 * sequence is the same either way: restart, wait for the daemon to come back,
 * refetch everything the old instance answered, then lower the pending flag.
 * A second copy of that would be a second place for the invalidate or the flag
 * to be forgotten.
 *
 * Failure is a toast, not a `window.alert`. The alert this replaced blocked the
 * whole renderer on a modal the user could only dismiss, and from the Dock it
 * would interrupt whatever they were doing elsewhere; every other failure in
 * the app already reports this way.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEngineStore, useToastStore } from "@/stores";
import { TIMING } from "@/config/timing";

export function useEngineRestart(): { restart: () => Promise<void>; isRestarting: boolean } {
	const [isRestarting, setIsRestarting] = useState(false);
	const queryClient = useQueryClient();
	const clearRestartRequired = useEngineStore((s) => s.clearRestartRequired);
	const showToast = useToastStore((s) => s.showToast);

	const restart = useCallback(async () => {
		if (!window.electronAPI) {
			// The renderer runs in a plain browser in dev, where there is no
			// daemon to restart - say so rather than appearing to have done it.
			showToast({
				message:
					"Engine restart is only available in the desktop app. Restart the engine manually.",
				variant: "warning",
			});
			return;
		}

		setIsRestarting(true);
		try {
			const result = await window.electronAPI.restartEngine();
			if (!result.success) {
				showToast({
					message: `Failed to restart engine: ${result.error ?? "unknown error"}`,
					variant: "error",
				});
				return;
			}
			// Give the daemon a moment to finish coming up before anything asks
			// it a question; then drop every cached answer the old instance
			// gave, since the new one may disagree with all of them.
			await new Promise((resolve) => setTimeout(resolve, TIMING.ENGINE_RESTART_WAIT_MS));
			await queryClient.invalidateQueries();
			// Last, and only on the success path: the pending signal is the
			// user's evidence that a saved value has not taken effect yet, so a
			// failed restart must leave it standing.
			clearRestartRequired();
		} finally {
			setIsRestarting(false);
		}
	}, [queryClient, clearRestartRequired, showToast]);

	return { restart, isRestarting };
}
