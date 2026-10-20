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
 * the collection tree contexts and throw without them, so a test that renders
 * one row in isolation - the hit-area guards, the click-delay guards - has to
 * supply the values. Written once here, feeding all three providers, so those
 * tests name only the two or three fields they actually assert on, rather than
 * restating twenty-five defaults each.
 *
 * Handlers default to no-ops, not spies: a test asserting a call passes its own
 * `vi.fn()` through `overrides`, which keeps the assertion and the spy in the
 * same file.
 */

import type { ReactNode } from "react";
import type {
	CollectionTreeFolderDraft,
	CollectionTreeHandlers,
	CollectionTreeState,
} from "@/modules/collections/context/CollectionTreeContext";
import { CollectionTreeProviders } from "@/modules/collections/context/CollectionTreeProviders";

/**
 * The three contexts' fields, flat, so a test names `selectedRequestId` and
 * `onRequestClick` side by side without knowing which context carries which.
 */
export type CollectionTreeTestValue = CollectionTreeState &
	CollectionTreeHandlers &
	CollectionTreeFolderDraft;

const noop = () => {};

const STATE_DEFAULTS: CollectionTreeState = {
	allCollections: [],
	expandedCollectionIds: new Set(),
	selectedCollectionId: null,
	selectedRequestId: null,
	getRequestsByCollection: () => [],
	renamingId: null,
	renamingRequestId: null,
	deletingCollectionId: null,
	deletingRequestId: null,
	creatingSubfolder: null,
	isCreatingSubfolder: false,
};

const HANDLER_DEFAULTS: CollectionTreeHandlers = {
	dnd: null,
	onCollectionClick: noop,
	onCollectionToggle: noop,
	onRequestClick: noop,
	getCollectionActions: () => [],
	onRenameSubmit: noop,
	onRenameCancel: noop,
	onStartRename: noop,
	onRequestRenameSubmit: noop,
	onRequestRenameCancel: noop,
	onStartRequestRename: noop,
	onCollectionDeleteClick: noop,
	onRequestDeleteClick: noop,
	onDuplicateRequest: noop,
	onFolderNameChange: noop,
	onCreateSubfolder: noop,
	onCancelSubfolder: noop,
};

const DRAFT_DEFAULTS: CollectionTreeFolderDraft = { newFolderName: "" };

/** The overrides that belong to `defaults`, laid over it. */
function withOverrides<T extends object>(
	defaults: T,
	overrides: Partial<CollectionTreeTestValue>
): T {
	const own = Object.fromEntries(Object.entries(overrides).filter(([key]) => key in defaults));
	return { ...defaults, ...own };
}

/**
 * The value each of the three contexts takes, from one flat set of overrides.
 * The parameter's type rejects a key no context owns, so the split below never
 * has a leftover to drop.
 */
export function collectionTreeContextParts(overrides: Partial<CollectionTreeTestValue> = {}) {
	return {
		state: withOverrides(STATE_DEFAULTS, overrides),
		handlers: withOverrides(HANDLER_DEFAULTS, overrides),
		folderDraft: withOverrides(DRAFT_DEFAULTS, overrides),
	};
}

export function withCollectionTreeContext(
	children: ReactNode,
	overrides: Partial<CollectionTreeTestValue> = {}
) {
	return (
		<CollectionTreeProviders {...collectionTreeContextParts(overrides)}>
			{children}
		</CollectionTreeProviders>
	);
}
