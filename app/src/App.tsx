/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useEffect } from "react";
import Shell from "./components/layout/Shell";
import TitleBar from "./components/layout/TitleBar";
import UpdateBanner from "./components/shared/UpdateBanner";
import Toaster from "./components/shared/Toaster";
import { useEngineStore } from "./stores";
import {
	useConfigQuery,
	useHealthQuery,
	usePrefetchCollectionsAndRequests,
	useRunsQuery,
} from "./queries";
import { useElectronTheme } from "./hooks/useElectronTheme";
import { useAppearance } from "./hooks/useAppearance";
import { useScriptCompletionProvider } from "./hooks/useScriptCompletionProvider";
import { useMenuActions } from "./hooks/useMenuActions";
import { useSaveStore } from "./stores/save-store";

function App() {
	const { isEngineConnected } = useEngineStore();

	// Sync theme with OS/Electron settings
	useElectronTheme();

	// Apply UI font + interface scale preferences
	useAppearance();

	// Initialize health check with automatic polling
	useHealthQuery();

	// Prefetch collections and all their requests (TanStack handles caching automatically)
	usePrefetchCollectionsAndRequests();
	useRunsQuery();

	// Keep engine config warm - proxied call timeouts derive from its
	// defaultTimeout setting (see services/api.ts proxiedRequestTimeoutMs)
	useConfigQuery();

	// Fetch pm.* completions and register them with Monaco's JavaScript language
	useScriptCompletionProvider();

	// Bridge native menu items (Preferences…/Settings) to in-app navigation
	useMenuActions();

	// Register Electron before-quit handler to flush pending saves
	useEffect(() => {
		if (!window.electronAPI?.onBeforeQuit) return;
		return window.electronAPI.onBeforeQuit(async () => {
			await useSaveStore.getState().flushAll();
		});
	}, []);

	// Log connection status for debugging
	if (isEngineConnected) {
		console.log("App: Engine connected, data queries active");
	}

	return (
		<div className="flex flex-col h-full">
			<TitleBar />
			<UpdateBanner />
			<div className="flex-1 overflow-hidden">
				<Shell />
			</div>
			<Toaster />
		</div>
	);
}

export default App;
