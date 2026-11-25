/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where a drop lands: the pointer offset within a row, resolved to a destination the reorder math
 * can take. Pure, like `reorder-math.ts`: the zone boundaries and landing rules are the part of a
 * drag worth pinning, and a jsdom gesture cannot reach them (no layout, so every row measures 0px
 * tall).
 *
 * **One list per parent.** A collection's sub-folders and requests share one `order` space (#2535),
 * so a drop between two rows lands between them whatever their kinds. The one place a kind still
 * refuses is the top level, which holds collections only: a request dropped on a root folder's edge
 * band has nowhere to sit, and the drop is refused rather than redirected to a position the
 * indicator did not show.
 */

/** A row in the tree, as much of it as a drop decision needs. */
export type TreeEntity =
	| { kind: "collection"; id: string; name: string; parentId: string | null }
	| { kind: "request"; id: string; name: string; collectionId: string };

/** The vertical band of a row the pointer is in. */
export type DropZone = "before" | "inside" | "after";

/**
 * How much of a folder row's height each edge band takes. The middle 50% is "into the folder", the
 * intent of most drops on a folder; the top and bottom quarters make reordering *between* folders
 * reachable without hunting for a 2px seam.
 */
export const FOLDER_EDGE_RATIO = 0.25;

/**
 * Which band `offsetY` falls in for a row `height` tall. A request row has no inside: it is 50/50.
 * A zero-height row (jsdom, or a row measured mid-unmount) resolves to `before` rather than
 * dividing by zero, the least surprising of the three; the caller still validates the result.
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
 * Where a drop puts the row: a parent, and a position among its children. `anchorId` is a sibling
 * to land beside (a drop between two rows); `null` is an end of the list (the head for `before`,
 * the tail for `after`), which is "into this folder" and stays expressible when the folder is
 * empty.
 */
export interface DropDestination {
	/** The parent: a collection id, or `null` for the top level. */
	ownerId: string | null;
	anchorId: string | null;
	placement: "before" | "after";
}

/**
 * The destination a drop of `dragged` onto `target` in `zone` means, or `null` for none, which is a
 * refusal, not a fallback. Identity ("onto itself") is refused here; descendant checks need the
 * whole tree, so the caller pairs this with `isDescendant`.
 */
export function resolveDrop(params: {
	dragged: TreeEntity;
	target: TreeEntity;
	zone: DropZone;
}): DropDestination | null {
	const { dragged, target, zone } = params;
	if (dragged.id === target.id) return null;

	if (target.kind === "collection" && zone === "inside") {
		return { ownerId: target.id, anchorId: null, placement: "after" };
	}
	const ownerId = target.kind === "collection" ? target.parentId : target.collectionId;
	// Beside a root folder is the top level, where only a collection can sit.
	if (dragged.kind === "request" && ownerId === null) return null;
	// A request row has no inside band; `zoneAt` never answers one for it.
	const placement = zone === "inside" ? "after" : zone;
	return { ownerId, anchorId: target.id, placement };
}
