/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import {
	CollectionTreeFolderDraftContext,
	CollectionTreeHandlersContext,
	CollectionTreeStateContext,
	type CollectionTreeFolderDraft,
	type CollectionTreeHandlers,
	type CollectionTreeState,
} from "./CollectionTreeContext";

/**
 * The three tree contexts, mounted together. Its own file because a module that
 * exports a component and hooks fails `react-refresh/only-export-components`,
 * and both the tree and the single-row test helper need exactly this nesting.
 */
export function CollectionTreeProviders({
	handlers,
	state,
	folderDraft,
	children,
}: {
	handlers: CollectionTreeHandlers;
	state: CollectionTreeState;
	folderDraft: CollectionTreeFolderDraft;
	children: ReactNode;
}) {
	return (
		<CollectionTreeHandlersContext.Provider value={handlers}>
			<CollectionTreeStateContext.Provider value={state}>
				<CollectionTreeFolderDraftContext.Provider value={folderDraft}>
					{children}
				</CollectionTreeFolderDraftContext.Provider>
			</CollectionTreeStateContext.Provider>
		</CollectionTreeHandlersContext.Provider>
	);
}
