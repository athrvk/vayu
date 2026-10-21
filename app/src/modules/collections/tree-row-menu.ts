/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A tree row's actions and the name of the menu listing them.
 *
 * Two menus show the list: the row's own `⋯` button, which the row builds, and
 * the tree's one right-click menu, which resolves the row under the pointer and
 * builds it here from the flat rows model (#2543). Both call the builders below,
 * so the right-click menu cannot offer a row something its `⋯` menu does not.
 */

import { Copy, CopyPlus, Edit2, Trash2 } from "lucide-react";
import type { RowAction } from "@/components/shared";
import { requestReference } from "@/lib/agent-reference";
import type { Collection, RequestSummary } from "@/types";
import type {
	CollectionTreeCrudHandlers,
	CollectionTreeHandlers,
	CollectionTreeState,
} from "./context/CollectionTreeContext";
import { collectionNamePath } from "./tree-utils";
import {
	collectionEntity,
	requestEntity,
	type FolderRow,
	type RequestRow,
	type TreeRow,
} from "./tree-rows";

export interface RowMenu {
	/** Names the menu for a screen reader. */
	label: string;
	actions: RowAction[];
}

/** `useCopy`'s `copy`. */
type CopyFn = (value: string, what: string) => Promise<void>;

/**
 * `inserted` goes before the destructive tail, not after it: `rowActionRows`
 * fences the first destructive item off from the ordinary ones above, and
 * appending past it would leave Move up / Move down below Delete's separator.
 */
function beforeDestructive(actions: RowAction[], inserted: RowAction[]): RowAction[] {
	const firstDestructive = actions.findIndex((a) => a.destructive);
	const at = firstDestructive < 0 ? actions.length : firstDestructive;
	return [...actions.slice(0, at), ...inserted, ...actions.slice(at)];
}

/**
 * A folder row's menu. The CRUD list comes from `useTreeCrud`; the move entries
 * from the drag slice, which mounts after it and is joined here rather than
 * threaded backwards into it.
 */
export function collectionRowMenu(
	collection: Collection,
	getCollectionActions: CollectionTreeCrudHandlers["getCollectionActions"],
	moveActions: RowAction[]
): RowMenu {
	return {
		label: `More actions for ${collection.name}`,
		actions: beforeDestructive(getCollectionActions(collection), moveActions),
	};
}

/** The line a request row's "Copy for agent" puts on the clipboard, folders included. */
export function requestRowReference(request: RequestSummary, allCollections: Collection[]): string {
	return requestReference(request, collectionNamePath(request.collectionId, allCollections));
}

export interface RequestMenuSources {
	handlers: Pick<
		CollectionTreeCrudHandlers,
		"onStartRequestRename" | "onDuplicateRequest" | "onRequestDeleteClick"
	>;
	/** `requestRowReference`'s line, which the item also shows as its hint. */
	reference: string;
	copy: CopyFn;
	moveActions: RowAction[];
	isDeleting: boolean;
}

/** A request row's menu. */
export function requestRowMenu(request: RequestSummary, sources: RequestMenuSources): RowMenu {
	const { handlers, reference, copy, moveActions, isDeleting } = sources;
	const own: RowAction[] = [
		{ label: "Rename", icon: Edit2, onSelect: () => handlers.onStartRequestRename(request) },
		{
			label: "Duplicate",
			icon: CopyPlus,
			onSelect: () => handlers.onDuplicateRequest(request),
		},
		{
			label: "Copy for agent",
			icon: Copy,
			hint: reference,
			onSelect: () => void copy(reference, "Reference"),
		},
		{
			label: "Delete",
			icon: Trash2,
			// The same soft delete, with its undo toast, as the Delete key's
			// hidden `data-tree-delete` control on the row.
			onSelect: () => {
				if (isDeleting) return;
				handlers.onRequestDeleteClick(request.id, request.name);
			},
			destructive: true,
		},
	];
	return {
		label: `More actions for request ${request.name}`,
		actions: beforeDestructive(own, moveActions),
	};
}

type ItemRow = FolderRow | RequestRow;

function isBusy(row: ItemRow, state: CollectionTreeState): boolean {
	if (row.kind === "folder") {
		const { id } = row.collection;
		return state.renamingId === id || state.deletingCollectionId === id;
	}
	const { id } = row.request;
	return state.renamingRequestId === id || state.deletingRequestId === id;
}

function itemRowMenu(
	row: ItemRow,
	state: CollectionTreeState,
	handlers: CollectionTreeHandlers,
	copy: CopyFn
): RowMenu {
	if (row.kind === "folder") {
		const moveActions = handlers.dnd?.moveActions(collectionEntity(row.collection)) ?? [];
		return collectionRowMenu(row.collection, handlers.getCollectionActions, moveActions);
	}
	return requestRowMenu(row.request, {
		handlers,
		reference: requestRowReference(row.request, state.allCollections),
		copy,
		moveActions: handlers.dnd?.moveActions(requestEntity(row.request, row.parentId)) ?? [],
		// `treeRowMenu` asks only for a row that is not busy.
		isDeleting: false,
	});
}

/**
 * The menu a right-click on `row` opens, or `null` when it opens none: the row
 * is not a treeitem, it is mid-rename or mid-delete (its field wants the
 * platform's own Cut/Copy/Paste), or it has nothing to offer. The rows apply
 * the same rule to the `own-menu` marker they carry, so the marker and the menu
 * come and go together.
 */
export function treeRowMenu(
	row: TreeRow,
	state: CollectionTreeState,
	handlers: CollectionTreeHandlers,
	copy: CopyFn
): RowMenu | null {
	if (row.kind !== "folder" && row.kind !== "request") return null;
	if (isBusy(row, state)) return null;
	const menu = itemRowMenu(row, state, handlers, copy);
	return menu.actions.length > 0 ? menu : null;
}
