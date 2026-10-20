/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The collection tree as the list of rows a user can see (#2543).
 *
 * The tree renders this array, top to bottom, as one flat list under
 * `role="tree"`: no row renders another, so the shape of the tree lives here
 * and in each row's `aria-level`, not in the DOM's nesting. One pure function
 * answers "what is on screen, in what order, at what depth and position", which
 * is what a windowed list needs to ask before it mounts anything.
 *
 * Order: the roots, then under each expanded folder its new-folder form when
 * open, the "Empty collection" line when it holds nothing, and its children -
 * sub-folders and requests in one sibling list (`mergeSiblings`, #2535), so a
 * request can sit above or between folders.
 */

import type { Collection, Request } from "@/types";
import { compareTreeOrder } from "@/types";
import type { TreeModelRow } from "./tree-focus";
import type { TreeEntity } from "./drop-position";
import { mergeSiblings } from "./tree-children";

interface RowBase {
	/** Stable across renders and unique across kinds: the row's React key. */
	key: string;
	/**
	 * 0 at the root; a treeitem announces `aria-level={depth + 1}`. A form or
	 * placeholder row has the depth of the children it stands in for, so it
	 * takes their left edge (`rowInsetPx`) rather than one of its own (#1372).
	 */
	depth: number;
	/**
	 * The folder this row is listed under, `null` at the root. An orphan's is
	 * `null` too, though its own `parentId` names the collection that is not
	 * loaded.
	 */
	parentId: string | null;
}

/**
 * A treeitem's place among its siblings. Folders and requests under one parent
 * are one set, numbered over the merged list they render in.
 */
interface SetPosition {
	posInSet: number;
	setSize: number;
}

export interface FolderRow extends RowBase, SetPosition {
	kind: "folder";
	collection: Collection;
	/**
	 * The "Empty collection" line that follows this row, which the row points
	 * `aria-describedby` at: that line is not a treeitem, so a screen reader
	 * walking the tree never lands on it. `null` unless the folder is expanded
	 * and holds nothing.
	 */
	emptyPlaceholderId: string | null;
}

export interface RequestRow extends RowBase, SetPosition {
	kind: "request";
	request: Request;
	/** The collection whose requests list this row came from. */
	parentId: string;
}

/** The inline "new collection" form, first under the folder it creates in. */
export interface NewFolderFormRow extends RowBase {
	kind: "new-folder-form";
	parentId: string;
}

/** The line an expanded, empty folder shows in place of its children. */
export interface EmptyPlaceholderRow extends RowBase {
	kind: "empty-placeholder";
	parentId: string;
	/** The element id the folder row's `aria-describedby` names. */
	id: string;
}

export type TreeRow = FolderRow | RequestRow | NewFolderFormRow | EmptyPlaceholderRow;

export interface VisibleRowsInput {
	collections: readonly Collection[];
	getRequestsByCollection: (collectionId: string) => readonly Request[];
	expandedCollectionIds: ReadonlySet<string>;
	/** The folder whose new-subfolder form is open, if any. */
	creatingSubfolder: string | null;
}

const FOLDER_KEY_PREFIX = "folder:";

/** A folder row's key. */
export function folderRowKey(collectionId: string): string {
	return `${FOLDER_KEY_PREFIX}${collectionId}`;
}

/** The collection a folder row's key names, `null` for any other row's key. */
export function folderIdOfRowKey(key: string): string | null {
	return key.startsWith(FOLDER_KEY_PREFIX) ? key.slice(FOLDER_KEY_PREFIX.length) : null;
}

/** A request row's key. */
export function requestRowKey(requestId: string): string {
	return `request:${requestId}`;
}

/** The key of the row an entity is shown on. */
export function entityRowKey(entity: Pick<TreeEntity, "kind" | "id">): string {
	return entity.kind === "collection" ? folderRowKey(entity.id) : requestRowKey(entity.id);
}

/** What a drag and a row's menu act on, for a folder row's collection. */
export function collectionEntity(collection: Collection): TreeEntity {
	return {
		kind: "collection",
		id: collection.id,
		name: collection.name,
		parentId: collection.parentId ?? null,
	};
}

/** The same for a request, listed under `collectionId`. */
export function requestEntity(request: Request, collectionId: string): TreeEntity {
	return { kind: "request", id: request.id, name: request.name, collectionId };
}

/** The entity a row stands for, `null` for a row that is not a treeitem. */
export function rowEntity(row: TreeRow): TreeEntity | null {
	if (row.kind === "folder") return collectionEntity(row.collection);
	if (row.kind === "request") return requestEntity(row.request, row.parentId);
	return null;
}

/** The key of the new-folder form open under `collectionId`. */
export function newFolderFormRowKey(collectionId: string): string {
	return `new-folder:${collectionId}`;
}

/** The element id of a folder's "Empty collection" line. */
export function emptyPlaceholderId(collectionId: string): string {
	return `tree-empty-${collectionId}`;
}

/**
 * The tree's top level: collections with no parent *and* those whose parent is
 * not loaded. An orphan used to match neither the roots filter nor any parent's
 * children, so it rendered nowhere - the shape a bad or half-applied reparent
 * leaves behind, and the user saw a collection silently disappear. Listed at the
 * root it is reachable, so it can be moved or deleted.
 */
function treeRoots(collections: readonly Collection[]): Collection[] {
	const loadedIds = new Set(collections.map((c) => c.id));
	return collections
		.filter((c) => !c.parentId || !loadedIds.has(c.parentId))
		.sort(compareTreeOrder);
}

/** Each parent's sub-folders, unsorted: `mergeSiblings` orders them with the requests. */
function childFoldersByParent(collections: readonly Collection[]): Map<string, Collection[]> {
	const byParent = new Map<string, Collection[]>();
	for (const collection of collections) {
		if (!collection.parentId) continue;
		const siblings = byParent.get(collection.parentId);
		if (siblings) siblings.push(collection);
		else byParent.set(collection.parentId, [collection]);
	}
	return byParent;
}

/** Every row a user can see, in the order they see it. */
export function flattenVisibleRows(input: VisibleRowsInput): TreeRow[] {
	const { expandedCollectionIds, creatingSubfolder, getRequestsByCollection } = input;
	const childFolders = childFoldersByParent(input.collections);
	const rows: TreeRow[] = [];
	// A folder already expanded into is never entered again. The data cannot
	// reach one twice through `parentId` alone, but a duplicated id in the list
	// would, and an unguarded walk is a hung window rather than a wrong answer
	// (see tree-utils).
	const entered = new Set<string>();

	const appendFolder = (
		collection: Collection,
		depth: number,
		parentId: string | null,
		position: SetPosition
	) => {
		const opens = expandedCollectionIds.has(collection.id) && !entered.has(collection.id);
		const children = opens
			? mergeSiblings(
					childFolders.get(collection.id) ?? [],
					getRequestsByCollection(collection.id)
				)
			: [];
		const hasForm = opens && creatingSubfolder === collection.id;
		const isEmpty = opens && !hasForm && children.length === 0;

		rows.push({
			kind: "folder",
			key: folderRowKey(collection.id),
			depth,
			parentId,
			...position,
			collection,
			emptyPlaceholderId: isEmpty ? emptyPlaceholderId(collection.id) : null,
		});
		if (!opens) return;
		entered.add(collection.id);

		const childDepth = depth + 1;
		const owner = collection.id;
		if (hasForm) {
			rows.push({
				kind: "new-folder-form",
				key: newFolderFormRowKey(owner),
				depth: childDepth,
				parentId: owner,
			});
		}
		if (isEmpty) {
			rows.push({
				kind: "empty-placeholder",
				key: `empty:${owner}`,
				depth: childDepth,
				parentId: owner,
				id: emptyPlaceholderId(owner),
			});
		}

		const setSize = children.length;
		children.forEach((child, index) => {
			const position = { posInSet: index + 1, setSize };
			if (child.kind === "collection") {
				appendFolder(child.collection, childDepth, owner, position);
				return;
			}
			rows.push({
				kind: "request",
				key: requestRowKey(child.id),
				depth: childDepth,
				parentId: owner,
				...position,
				request: child.request,
			});
		});
	};

	const roots = treeRoots(input.collections);
	roots.forEach((root, index) =>
		appendFolder(root, 0, null, { posInSet: index + 1, setSize: roots.length })
	);
	return rows;
}

/**
 * The space above `rows[index]`, in Tailwind spacing units (`--spacing`, so it
 * follows the density setting the way the rows' `h-8` does).
 *
 * Half a unit between rows, and a whole unit above the first row inside an
 * expanded folder - the `space-y-0.5` between siblings and the `mt-1` above a
 * nested group that the tree drew when it was nested. A row starts a group
 * exactly when it is deeper than the row before it, because depth only ever
 * steps down one level at a time, into the folder just above.
 */
export function rowSpacingAbove(rows: readonly TreeRow[], index: number): 0 | 0.5 | 1 {
	if (index <= 0) return 0;
	return rows[index].depth > rows[index - 1].depth ? 1 : 0.5;
}

/**
 * The keys of every row inside `collectionId`'s subtree, the folder's own row
 * excluded: the rows following it that sit deeper than it does. Empty when the
 * folder is not visible or not expanded.
 */
export function rowKeysUnder(rows: readonly TreeRow[], collectionId: string): Set<string> {
	const keys = new Set<string>();
	const start = rows.findIndex(
		(row) => row.kind === "folder" && row.collection.id === collectionId
	);
	if (start === -1) return keys;
	const depth = rows[start].depth;
	for (let index = start + 1; index < rows.length && rows[index].depth > depth; index++) {
		keys.add(rows[index].key);
	}
	return keys;
}

/**
 * A row's height in spacing units, which its wrapper in `CollectionTreeRows`
 * is given as a class: the window's arithmetic and the layout read the one
 * number, so they cannot disagree. A folder and a request row are `h-8`, and so
 * is the "Empty collection" line; the new-folder form is its `control-sm` field
 * plus `py-1`, which is ten units at both densities.
 */
export function rowHeightUnits(row: TreeRow): 8 | 10 {
	return row.kind === "new-folder-form" ? 10 : 8;
}

/** Each row's full pitch, in spacing units: the gap above it and its height. */
export function rowStrides(rows: readonly TreeRow[]): number[] {
	return rows.map((row, index) => rowSpacingAbove(rows, index) + rowHeightUnits(row));
}

function isTreeItem(row: TreeRow | undefined): row is FolderRow | RequestRow {
	return row?.kind === "folder" || row?.kind === "request";
}

/**
 * The treeitems alone, as the keyboard walks them: every row a screen reader
 * can land on, mounted or not, with the name a typeahead matches.
 */
export function navigableRows(
	rows: readonly TreeRow[],
	expandedCollectionIds: ReadonlySet<string>
): TreeModelRow[] {
	return rows.filter(isTreeItem).map((row) =>
		row.kind === "folder"
			? {
					key: row.key,
					level: row.depth + 1,
					label: row.collection.name,
					expanded: expandedCollectionIds.has(row.collection.id),
				}
			: { key: row.key, level: row.depth + 1, label: row.request.name, expanded: null }
	);
}

/**
 * The rows that must stay mounted beside the one holding the tree's tab stop.
 *
 * The treeitems on either side of `rows[index]`, its ancestors, and the first
 * row past its subtree. The row before it, its parent and the row past its
 * subtree are the three places a delete hands focus to (`rowAfterRemoving`),
 * which reads only the mounted rows: with these pinned it gives the answer the
 * whole list would.
 */
export function rowsAroundFocus(rows: readonly TreeRow[], index: number): number[] {
	const row = rows[index];
	if (!row) return [];
	const around = [index];

	let before = index - 1;
	while (before >= 0 && !isTreeItem(rows[before])) before--;
	if (before >= 0) around.push(before);

	let after = index + 1;
	while (after < rows.length && !isTreeItem(rows[after])) after++;
	if (after < rows.length) around.push(after);

	let past = index + 1;
	while (past < rows.length && rows[past].depth > row.depth) past++;
	if (past < rows.length) around.push(past);

	let depth = row.depth;
	for (let above = index - 1; above >= 0 && depth > 0; above--) {
		if (rows[above].depth >= depth) continue;
		around.push(above);
		depth = rows[above].depth;
	}
	return around;
}
