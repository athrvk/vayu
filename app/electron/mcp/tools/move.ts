/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file move.ts
 * @brief Moving an item to another parent: where it lands among its new
 *        siblings.
 */

import { collectionParent, type CollectionRow } from "./cascade.js";
import { mergeSiblings, type OrderedRow, type SiblingKind } from "./sibling-order.js";

/**
 * Where a moved row lands among its new siblings.
 *
 * Two positions, not an index: `POST /reorder` writes dense positions and a
 * drag computes them from a pointer, which an agent has none of. Naming a slot
 * in the middle would mean an agent maintaining the app's ordering arithmetic
 * (`modules/collections/reorder-math.ts`) from the outside, and getting it wrong
 * is a folder that visibly reshuffles. First and last are the two an agent can
 * mean unambiguously; anything finer stays a UI gesture.
 */
export const MOVE_POSITIONS = ["first", "last"] as const;

/**
 * The reorder batch that lands `movedId` at either end of its destination.
 *
 * `siblings` is the destination parent's children **of both kinds**, in
 * sibling order (`mergeSiblings`), with the moved row itself removed: a
 * collection's sub-collections and its requests share one `order` space
 * (#2535), so the end of a parent is past every child it has, and an end
 * computed over one kind lands the row among the other's slots. The
 * arrangement this produces is that list with the row put on one end. Every
 * position in it is then stated outright rather than left to the engine's
 * `normalize` pass, because the two would have to agree about a list the moved
 * row is still inside while it runs: normalizing `[A, B, C]` and then writing
 * `A` at `2` puts it level with `C`, and the tie goes to the rank and creation
 * time rather than to the move. Stating the whole arrangement cannot tie.
 *
 * Only rows whose stored `order` actually changes get an entry, each under its
 * own `type` - the rule `reorder-math.ts` follows for a drag, and what keeps a
 * move inside a large collection from rewriting every row in it. The moved row
 * is always written: it is the one carrying the destination owner, which is the
 * move.
 *
 * The parent it *left* keeps a gap where it was (the rows after it are not
 * renumbered). That is invisible - display order reads the column's relative
 * values, never its density - and closing it would double the batch for
 * nothing.
 */
export function moveBatch(params: {
	type: SiblingKind;
	movedId: string;
	position: "first" | "last";
	/** The destination's own key: `parentId` (null = the top level) or `collectionId`. */
	owner: Record<string, unknown>;
	siblings: ReadonlyArray<OrderedRow & { kind: SiblingKind }>;
}): Record<string, unknown> {
	const { type, movedId, position, owner, siblings } = params;
	const offset = position === "first" ? 1 : 0;
	const moves: Record<string, unknown>[] = [
		{
			type,
			id: movedId,
			order: position === "first" ? 0 : siblings.length,
			...owner,
		},
	];
	siblings.forEach((row, index) => {
		if (row.order === index + offset) return;
		moves.push({ type: row.kind, id: row.id, order: index + offset });
	});
	return { moves };
}

/**
 * Every child of `parentId` except the row being moved, in sibling order.
 *
 * `collections` is the whole `GET /collections` list and `requests` the
 * `GET /requests?collectionId=` answer for `parentId` (the top level holds
 * collections only, so pass none for `null`). The moved row is matched by kind
 * as well as id, so a move within its own parent never drops a sibling of the
 * other kind.
 */
export function destinationSiblings(params: {
	type: SiblingKind;
	movedId: string;
	parentId: string | null;
	collections: readonly CollectionRow[];
	requests: readonly OrderedRow[];
}): Array<OrderedRow & { kind: SiblingKind }> {
	const { type, movedId, parentId, collections, requests } = params;
	const folders = collections.filter((row) => collectionParent(row) === parentId);
	return mergeSiblings(folders, requests).filter(
		(row) => !(row.kind === type && row.id === movedId)
	);
}
