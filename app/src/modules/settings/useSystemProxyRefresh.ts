/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keep the resolved system proxy current while the network settings are open (#708).
 *
 * The resolution happens in the Electron main process, the only part of Vayu that can ask the OS,
 * at startup and on wake. This is the renderer's half of "on network change": the browser's
 * `online` event, which fires for the transitions (a laptop rejoining a network, a VPN coming up)
 * that change the answer while the app runs and never reach `powerMonitor`.
 *
 * It also refreshes on mount, because someone reading the network settings is about to *believe*
 * the resolved row, and a stale one is worse than none. Main writes nothing when the answer has not
 * moved, so the eagerness costs one comparison.
 *
 * Outside Electron (vitest, the browser preview) `electronAPI` is absent and this does nothing,
 * which is correct, not degraded: there is no OS proxy to resolve without a Chromium session to
 * ask.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/queries/keys";

export function useSystemProxyRefresh(): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		const api = window.electronAPI;
		if (!api?.refreshSystemProxy) return;

		let cancelled = false;
		const refresh = () => {
			void api.refreshSystemProxy().then((resolved) => {
				// Null means the resolution could not be made; nothing was
				// written, so nothing in the cache is stale. Invalidating on it
				// anyway would refetch the whole config for no change.
				if (cancelled || resolved === null) return;
				void queryClient.invalidateQueries({ queryKey: queryKeys.config.all });
			});
		};

		refresh();
		window.addEventListener("online", refresh);
		return () => {
			cancelled = true;
			window.removeEventListener("online", refresh);
		};
	}, [queryClient]);
}
