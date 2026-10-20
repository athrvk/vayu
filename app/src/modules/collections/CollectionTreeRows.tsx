/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { memo, useMemo } from "react";
import CollectionItem from "./CollectionItem";
import RequestItem from "./RequestItem";
import NewFolderForm from "./NewFolderForm";
import { useCollectionTreeState } from "./context/CollectionTreeContext";
import { rowKeysUnder, rowSpacingAbove, type TreeRow } from "./tree-rows";
import { cn } from "@/lib/utils";
import { rowInsetPx } from "@/constants/layout";

/** `rowSpacingAbove`'s units as classes, written out whole for Tailwind's scan. */
const SPACING_ABOVE_CLASS = { 0: "", 0.5: "mt-0.5", 1: "mt-1" } as const;

const NO_ROWS = new Set<string>();

function RowContent({ row }: { row: TreeRow }) {
	switch (row.kind) {
		case "folder":
			return (
				<CollectionItem
					collection={row.collection}
					depth={row.depth}
					posInSet={row.posInSet}
					setSize={row.setSize}
					emptyPlaceholderId={row.emptyPlaceholderId}
				/>
			);
		case "request":
			return (
				<RequestItem
					request={row.request}
					collectionId={row.parentId}
					depth={row.depth}
					posInSet={row.posInSet}
					setSize={row.setSize}
				/>
			);
		case "new-folder-form":
			return <NewFolderForm parentId={row.parentId} indentPx={rowInsetPx(row.depth)} />;
		case "empty-placeholder":
			// No role: it is not a treeitem, and the folder row above names it
			// through `aria-describedby` instead.
			return (
				<div
					id={row.id}
					className="py-2 pr-3 text-xs text-muted-foreground"
					style={{ paddingLeft: rowInsetPx(row.depth) }}
				>
					Empty collection
				</div>
			);
	}
}

/**
 * The tree's rows, one flat list in the order `flattenVisibleRows` gives them.
 *
 * Each row sits in a wrapper that owns what used to come from nesting: the gap
 * above it, and the dimming of everything inside a folder being deleted. Memoised
 * so a keystroke in the new-folder field, which re-renders the tree, does not
 * walk the list: `rows` changes only when what is visible does.
 */
function CollectionTreeRowList({ rows }: { rows: readonly TreeRow[] }) {
	const { deletingCollectionId } = useCollectionTreeState();
	const dimmed = useMemo(
		() => (deletingCollectionId ? rowKeysUnder(rows, deletingCollectionId) : NO_ROWS),
		[rows, deletingCollectionId]
	);

	return rows.map((row, index) => (
		<div
			key={row.key}
			className={cn(
				SPACING_ABOVE_CLASS[rowSpacingAbove(rows, index)],
				dimmed.has(row.key) && "opacity-50"
			)}
		>
			<RowContent row={row} />
		</div>
	));
}

const CollectionTreeRows = memo(CollectionTreeRowList);
export default CollectionTreeRows;
