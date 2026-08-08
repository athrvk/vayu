/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a drop lands: pointer offset within a row, plus the folders-first block
 * rule, resolved to a destination the reorder math can be handed.
 *
 * Pure, for the same reason `reorder-math.ts` is: the zone boundaries and the
 * block rule are the part of a drag that is worth pinning, and a jsdom gesture
 * cannot reach them (jsdom has no layout, so every row measures 0px tall).
 *
 * **Two ordered blocks, never interleaved.** A collection's children are its
 * subfolders followed by its requests, and the `order` column is per block - a
 * request cannot sit between two folders, whatever the pointer is over. So a
 * zone is resolved against the *dragged* row's kind as well as the target's,
 * and the result names the block it lands in rather than a pixel position:
 *
 *   - request dropped between two folders -> the head of that parent's requests
 *   - request dropped on a folder's middle -> into that folder's requests
 *   - collection dropped on a folder's middle -> into that folder's subfolders
 *   - collection dropped on a request row -> refused; requests are not its block
 *
 * The last one is a refusal rather than a redirect on purpose. Every other case
 * lands where the indicator says it will; a folder silently jumping to the end
 * of some other block because the pointer was over a request would not.
 */

/** A row in the tree, as much of it as a drop decision needs. */
export type TreeEntity =
	| { kind: "collection"; id: string; name: string; parentId: string | null }
	| { kind: "request"; id: string; name: string; collectionId: string };

/** The vertical band of a row the pointer is in. */
export type DropZone = "before" | "inside" | "after";

/**
 * How much of a folder row's height each edge band takes. The middle 50% is
 * "into the folder", which is the intent most drops on a folder have; the
 * quarters at top and bottom are what make reordering *between* folders
 * reachable without hunting for a 2px seam.
 */
export const FOLDER_EDGE_RATIO = 0.25;

/**
 * Which band `offsetY` falls in for a row `height` tall.
 *
 * A request row has no inside: it is 50/50. A zero-height row (jsdom, or a row
 * measured mid-unmount) resolves to `before` rather than dividing by zero - the
 * least surprising of the three, and the caller still validates the result.
 */
export function zoneAt(offsetY: number, height: number, isFolder: boolean): DropZone {
	if (height <= 0) return "before";
	const ratio = Math.min(Math.max(offsetY / height, 0), 1);
	if (!isFolder) return ratio < 0.5 ? "before" : "after";
	if (ratio < FOLDER_EDGE_RATIO) return "before";
	if (ratio > 1 - FOLDER_EDGE_RATIO) return "after";
	return "inside";
}

/**
 * Where a drop puts the row: one ordered block, and a position in it.
 *
 * `anchorId` is a sibling to land beside, which is what a drop between two rows
 * means. `null` means an end of the block - the head for `before`, the tail for
 * `after` - which is what "into this folder" and "out to the top level" mean,
 * and it stays expressible when the block is empty.
 */
export interface DropDestination {
	block: "collections" | "requests";
	/** Owner of the block: a collection id, or `null` for the root collections. */
	ownerId: string | null;
	anchorId: string | null;
	placement: "before" | "after";
}

/**
 * The destination a drop of `dragged` onto `target` in `zone` means, or `null`
 * when there is none - which is a refusal to drop, not a fallback.
 *
 * Identity ("onto itself") is refused here; descendant checks are not, because
 * they need the whole tree - the caller pairs this with `isDescendant`.
 */
export function resolveDrop(params: {
	dragged: TreeEntity;
	target: TreeEntity;
	zone: DropZone;
}): DropDestination | null {
	const { dragged, target, zone } = params;
	if (dragged.id === target.id) return null;

	if (dragged.kind === "collection") {
		// A folder's block is the subfolders of some parent. A request row is in
		// the other block, so it names no position a folder can take.
		if (target.kind !== "collection") return null;
		if (zone === "inside") {
			return { block: "collections", ownerId: target.id, anchorId: null, placement: "after" };
		}
		return {
			block: "collections",
			ownerId: target.parentId,
			anchorId: target.id,
			placement: zone,
		};
	}

	if (target.kind === "request") {
		return {
			block: "requests",
			ownerId: target.collectionId,
			anchorId: target.id,
			placement: zone === "inside" ? "after" : zone,
		};
	}

	if (zone === "inside") {
		return { block: "requests", ownerId: target.id, anchorId: null, placement: "after" };
	}
	// Between two folders. The requests block of the folder's own parent is the
	// nearest place a request can actually sit, and its head is where the
	// gesture pointed - just below the folders. A root folder has no parent, so
	// there is no requests block there at all and the drop is refused.
	if (target.parentId === null) return null;
	return { block: "requests", ownerId: target.parentId, anchorId: null, placement: "before" };
}
