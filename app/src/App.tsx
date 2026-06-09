/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import Shell from "./components/layout/Shell";
import TitleBar from "./components/layout/TitleBar";
import UpdateBanner from "./components/shared/UpdateBanner";
import { useEngineConnectionStore } from "./stores";
import { useHealthQuery, usePrefetchCollectionsAndRequests, useRunsQuery } from "./queries";
import { useElectronTheme } from "./hooks/useElectronTheme";
import { useScriptCompletionProvider } from "./hooks/useScriptCompletionProvider";
import { useMenuActions } from "./hooks/useMenuActions";

function App() {
	const { isEngineConnected } = useEngineConnectionStore();

	// Sync theme with OS/Electron settings
	useElectronTheme();

	// Initialize health check with automatic polling
	useHealthQuery();

	// Prefetch collections and all their requests (TanStack handles caching automatically)
	usePrefetchCollectionsAndRequests();
	useRunsQuery();

	// Fetch pm.* completions and register them with Monaco's JavaScript language
	useScriptCompletionProvider();

	// Bridge native menu items (Preferences…/Settings) to in-app navigation
	useMenuActions();

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
		</div>
	);
}

export default App;
