/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection-tree context for tests that render a single row.
 *
 * `CollectionItem` and `RequestItem` read their shared state and handlers from
 * `CollectionTreeContext` and throw without it, so a test that renders one row
 * in isolation - the hit-area guards, the click-delay guards - has to supply
 * the value. Written once here so those tests name only the two or three fields
 * they actually assert on, rather than restating twenty-five defaults each.
 *
 * Handlers default to no-ops, not spies: a test asserting a call passes its own
 * `vi.fn()` through `overrides`, which keeps the assertion and the spy in the
 * same file.
 */

import type { ReactNode } from "react";
import {
	CollectionTreeContext,
	type CollectionTreeContextValue,
} from "@/modules/collections/context/CollectionTreeContext";

const noop = () => {};

export function collectionTreeContextValue(
	overrides: Partial<CollectionTreeContextValue> = {}
): CollectionTreeContextValue {
	return {
		allCollections: [],
		expandedCollectionIds: new Set(),
		selectedCollectionId: null,
		selectedRequestId: null,
		getRequestsByCollection: () => [],
		dnd: null,
		renamingId: null,
		renameValue: "",
		renamingRequestId: null,
		renameRequestValue: "",
		deletingCollectionId: null,
		deletingRequestId: null,
		creatingSubfolder: null,
		newSubCollectionName: "",
		isCreatingSubfolder: false,
		onCollectionClick: noop,
		onCollectionToggle: noop,
		onRequestClick: noop,
		getCollectionActions: () => [],
		onRenameChange: noop,
		onRenameSubmit: noop,
		onRenameCancel: noop,
		onStartRename: noop,
		onRequestRenameChange: noop,
		onRequestRenameSubmit: noop,
		onRequestRenameCancel: noop,
		onStartRequestRename: noop,
		onCollectionDeleteClick: noop,
		onRequestDeleteClick: noop,
		onDuplicateRequest: noop,
		onSubCollectionNameChange: noop,
		onCreateSubfolder: noop,
		onCancelSubfolder: noop,
		...overrides,
	};
}

export function withCollectionTreeContext(
	children: ReactNode,
	overrides: Partial<CollectionTreeContextValue> = {}
) {
	return (
		<CollectionTreeContext.Provider value={collectionTreeContextValue(overrides)}>
			{children}
		</CollectionTreeContext.Provider>
	);
}
