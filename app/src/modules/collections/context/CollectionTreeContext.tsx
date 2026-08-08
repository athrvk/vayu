/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection tree context
 *
 * Every value a tree row needs that is not the row itself. `CollectionItem`
 * renders itself recursively, so anything threaded as a prop had to be
 * re-listed at four sites - the tree's map, the item's prop list, its
 * destructure, and its recursive call. Thirty of the item's thirty-three props
 * were the same object arriving at every depth, so a single new value (a drag
 * id, a drop target) cost four edits before it did anything.
 *
 * The context carries exactly that shared slice. What stays a prop is what
 * genuinely differs per row: the entity, its depth, and its position in the
 * sibling set.
 */

import { createContext, useContext } from "react";
import type { Collection, Request } from "@/types";
import type { RowAction } from "@/components/shared";

/**
 * Where a drop would land: `inside` reparents into a folder, `before` / `after`
 * reorder among the target's siblings.
 */
export interface CollectionTreeDropTarget {
	id: string;
	position: "before" | "after" | "inside";
}

/**
 * The drag-and-drop slice, phase 3 of #364 (#367). Typed and present now, so
 * the `useTreeDnd` hook lands as one provider field plus row wiring rather than
 * as another pass through the prop thread this context exists to remove.
 * `null` means no drag machinery is mounted - which is every render until #367.
 */
export interface CollectionTreeDnd {
	/** The entity being dragged, or null when no drag is in progress. */
	draggingId: string | null;
	/** The row the pointer is over, and where the drop would land on it. */
	dropTarget: CollectionTreeDropTarget | null;
}

/**
 * The state and handlers `useTreeCrud` owns and every row reads. Split out so
 * the hook can type its row-facing return without importing the whole context
 * value, and so the two stay in step by construction.
 */
export interface CollectionTreeCrudSlice {
	/** Collection currently being renamed inline, if any. */
	renamingId: string | null;
	renameValue: string;
	/** Request currently being renamed inline, if any. */
	renamingRequestId: string | null;
	renameRequestValue: string;
	/** Rows mid-delete render dimmed and refuse input. */
	deletingCollectionId: string | null;
	deletingRequestId: string | null;
	/** Collection whose "new folder" form is open, if any. */
	creatingSubfolder: string | null;
	newSubCollectionName: string;
	isCreatingSubfolder: boolean;

	onCollectionClick: (collection: Collection) => void;
	onCollectionToggle: (collection: Collection) => void;
	onRequestClick: (collectionId: string, requestId: string) => void;
	/** Actions for a collection's ⋯ menu, built where the handlers live. */
	getCollectionActions: (collection: Collection) => RowAction[];

	onRenameChange: (value: string) => void;
	onRenameSubmit: (collectionId: string) => void;
	onRenameCancel: () => void;
	onStartRename: (collection: Collection) => void;

	onRequestRenameChange: (value: string) => void;
	onRequestRenameSubmit: (requestId: string) => void;
	onRequestRenameCancel: () => void;
	onStartRequestRename: (request: Request) => void;

	/**
	 * Opens the delete confirm dialog. Both rows go through it - the ⋯ menu and
	 * the hidden `data-tree-delete` control the Delete key clicks - so a cascade
	 * delete is never one keystroke.
	 */
	onCollectionDeleteClick: (collectionId: string, collectionName: string) => void;
	onRequestDeleteClick: (requestId: string, requestName: string) => void;
	onDuplicateRequest: (request: Request) => void;

	onSubCollectionNameChange: (value: string) => void;
	onCreateSubfolder: (parentId: string) => void;
	onCancelSubfolder: () => void;
}

export interface CollectionTreeContextValue extends CollectionTreeCrudSlice {
	/** Every loaded collection - a row filters it for its own children. */
	allCollections: Collection[];
	expandedCollectionIds: Set<string>;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	getRequestsByCollection: (collectionId: string) => Request[];
	dnd: CollectionTreeDnd | null;
}

export const CollectionTreeContext = createContext<CollectionTreeContextValue | null>(null);

export function useCollectionTreeContext(): CollectionTreeContextValue {
	const context = useContext(CollectionTreeContext);
	if (!context) {
		throw new Error(
			"Collection tree rows must be rendered inside CollectionTreeContext.Provider"
		);
	}
	return context;
}
