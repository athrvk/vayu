/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useDataFileStore } from "@/stores/data-file-store";

/**
 * Keep the main process's copy of the remembered data-file paths current, so
 * an MCP client can be told where a collection's data file is (issue #1742).
 *
 * Mounted once at the root: the store is the record and this only mirrors it,
 * on mount (a launch or a reload, when main's copy is empty or stale) and on
 * every change to `locations`. Absent outside Electron, where there is no MCP
 * server to tell.
 */
export function useDataFileLocationMirror(): void {
	useEffect(() => {
		const publish = window.electronAPI?.publishDataFileLocations;
		if (!publish) return;
		publish(useDataFileStore.getState().locations);
		return useDataFileStore.subscribe((state, previous) => {
			if (state.locations !== previous.locations) publish(state.locations);
		});
	}, []);
}
