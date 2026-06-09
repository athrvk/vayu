/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import { useNavigationStore } from "@/stores";

/**
 * Bridges native menu items (Preferences… / Settings) to in-app navigation.
 * No-op outside Electron.
 */
export function useMenuActions(): void {
	const navigateToSettings = useNavigationStore((s) => s.navigateToSettings);

	useEffect(() => {
		// Optional-chain the call too: an older preload build may not expose
		// onOpenSettings yet, and `?.` on electronAPI alone wouldn't guard that.
		return window.electronAPI?.onOpenSettings?.(() => navigateToSettings());
	}, [navigateToSettings]);
}
