/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Collection tree context
 *
 * Every value a tree row needs that is not the row itself. Thirty-odd values
 * are the same for every row, and as props each had to be re-listed at every
 * site between the tree and the row, so a single new value (a drag id, a drop
 * target) cost several edits before it did anything.
 *
 * The context carries exactly that shared slice. What stays a prop is what
 * genuinely differs per row: the entity, its depth, and its position in the
 * sibling set.
 *
 * **Three contexts, by how often the value changes** (#2543). Every consumer of
 * a context re-renders when its value changes, so one value holding a
 * per-keystroke string and a per-pointer-move drop target rebuilt every mounted
 * row for each of them. A row subscribes to the narrowest of the three that
 * answers its question:
 *
 * - `CollectionTreeHandlersContext`: functions, with an identity that holds
 *   across a keystroke and a pointer move. It changes only when the data a
 *   render-time function reads does (`getCollectionActions` over the loaded
 *   collections).
 * - `CollectionTreeStateContext`: the tree's data and the rename / delete
 *   state. It changes when the tree does.
 * - `CollectionTreeFolderDraftContext`: the half-typed new-folder name, read by
 *   the one form that edits it and by nothing else.
 *
 * The drag indicator is not a context at all: it changes on every row the
 * pointer crosses, so it lives in a store a row subscribes to with a selector
 * (`CollectionTreeDnd.dragState`), and only the rows whose answer changed
 * render.
 */

import { createContext, useContext } from "react";
import type { StoreApi } from "zustand";
import type { Collection, RequestSummary } from "@/types";
import type { RowAction } from "@/components/shared";
import type { TreeEntity } from "../drop-position";

/**
 * Where a drop would land: `inside` reparents into a folder, `before` / `after`
 * reorder among the target's siblings.
 */
export interface CollectionTreeDropTarget {
	id: string;
	position: "before" | "after" | "inside";
}

/** Alt+Arrow, in tree terms: among siblings, into the folder above, out to the parent. */
export type TreeMoveDirection = "up" | "down" | "in" | "out";

/**
 * What the drag indicator is drawn from. Held in a store rather than a context
 * value because `dropTarget` changes on every row the pointer crosses: a row
 * subscribes to the one fact it draws (`dropTarget?.id === its id`) and a
 * crossing renders the two rows whose answer changed, not the tree.
 */
export interface CollectionTreeDragState {
	/** The entity being dragged, or null when no drag is in progress. */
	dragging: TreeEntity | null;
	/** The row the pointer is over, and where the drop would land on it. */
	dropTarget: CollectionTreeDropTarget | null;
}

/**
 * The drag-and-drop slice, phase 3 of #364 (#367). It arrives through the
 * context rather than as props because it is the same for every row.
 *
 * Every member keeps one identity for the life of the tree (#2543): the volatile
 * part of a drag is `dragState`, subscribed to, never read off this object.
 *
 * `null` means no drag machinery is mounted, which is what a test rendering a
 * single row in isolation gets - the rows must stay usable without it.
 */
export interface CollectionTreeDnd {
	dragState: StoreApi<CollectionTreeDragState>;
	/**
	 * True while `entity` is an illegal target for the row being `dragged` - the
	 * dragged folder's own subtree, or a row no band of which names a destination.
	 */
	isDropBlocked: (dragged: TreeEntity, entity: TreeEntity) => boolean;
	moveByKeyboard: (entity: TreeEntity, direction: TreeMoveDirection) => void;
	/**
	 * The row menu's move entries - Move up, Move down, "Move to…" - the
	 * discoverable path that needs no chords (#1690). A factory rather than
	 * handlers so both row types get one list, worded, iconed and gated once,
	 * instead of two copies that drift.
	 */
	moveActions: (entity: TreeEntity) => RowAction[];
}

/**
 * The state `useTreeCrud` owns and every row reads. Split from the handlers so
 * the hook can type its row-facing return without importing the whole context
 * value, and so the two stay in step by construction. The half-typed new-folder
 * name is not here: see `CollectionTreeFolderDraft`.
 */
export interface CollectionTreeCrudState {
	/** Collection currently being renamed inline, if any. */
	renamingId: string | null;
	/** Request currently being renamed inline, if any. */
	renamingRequestId: string | null;
	/** Rows mid-delete render dimmed and refuse input. */
	deletingCollectionId: string | null;
	deletingRequestId: string | null;
	/** Collection whose "new folder" form is open, if any. */
	creatingSubfolder: string | null;
	isCreatingSubfolder: boolean;
}

/**
 * The handlers `useTreeCrud` owns and every row calls. Each is either called
 * only from an event (and so identity-stable, reading current state through
 * `useStableCallback`) or called while a row renders (`getCollectionActions`,
 * which changes exactly when the collections it describes do).
 */
export interface CollectionTreeCrudHandlers {
	onCollectionClick: (collection: Collection) => void;
	onCollectionToggle: (collection: Collection) => void;
	onRequestClick: (collectionId: string, requestId: string) => void;
	/** Actions for a collection's ⋯ menu, built where the handlers live. */
	getCollectionActions: (collection: Collection) => RowAction[];

	/**
	 * The draft name lives in the row's `useInlineRename`, not here: the field is
	 * mounted by exactly one row at a time, and a second copy of it up here was
	 * a value two layers could disagree about. Submit therefore carries the
	 * trimmed name the hook already holds.
	 */
	onRenameSubmit: (collectionId: string, name: string) => void;
	onRenameCancel: () => void;
	onStartRename: (collection: Collection) => void;

	onRequestRenameSubmit: (requestId: string, name: string) => void;
	onRequestRenameCancel: () => void;
	onStartRequestRename: (request: RequestSummary) => void;

	/**
	 * Starts a delete. Both paths go through it - the ⋯ menu and the hidden
	 * `data-tree-delete` control the Delete key clicks - so they cannot differ:
	 * a soft delete with an undo toast, asked about first only when it would
	 * stop a running mock server (`CollectionTree`'s `deleteNeedsConfirm`).
	 */
	onCollectionDeleteClick: (collectionId: string, collectionName: string) => void;
	onRequestDeleteClick: (requestId: string, requestName: string) => void;
	onDuplicateRequest: (request: RequestSummary) => void;

	onFolderNameChange: (value: string) => void;
	onCreateSubfolder: (parentId: string) => void;
	onCancelSubfolder: () => void;
}

export interface CollectionTreeHandlers extends CollectionTreeCrudHandlers {
	dnd: CollectionTreeDnd | null;
}

export interface CollectionTreeState extends CollectionTreeCrudState {
	/** Every loaded collection - what a row's count and its path are read from. */
	allCollections: Collection[];
	expandedCollectionIds: Set<string>;
	selectedCollectionId: string | null;
	selectedRequestId: string | null;
	getRequestsByCollection: (collectionId: string) => RequestSummary[];
}

/**
 * The new-folder field's text, alone in its context: it changes on every
 * keystroke, and the only reader is the form the editing folder mounts.
 */
export interface CollectionTreeFolderDraft {
	newFolderName: string;
}

export const CollectionTreeHandlersContext = createContext<CollectionTreeHandlers | null>(null);
export const CollectionTreeStateContext = createContext<CollectionTreeState | null>(null);
export const CollectionTreeFolderDraftContext = createContext<CollectionTreeFolderDraft | null>(
	null
);

function useRequiredContext<T>(context: React.Context<T | null>): T {
	const value = useContext(context);
	if (!value) {
		throw new Error("Collection tree rows must be rendered inside CollectionTreeProviders");
	}
	return value;
}

export const useCollectionTreeHandlers = () => useRequiredContext(CollectionTreeHandlersContext);
export const useCollectionTreeState = () => useRequiredContext(CollectionTreeStateContext);
export const useCollectionTreeFolderDraft = () =>
	useRequiredContext(CollectionTreeFolderDraftContext);
