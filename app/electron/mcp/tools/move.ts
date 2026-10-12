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
 * `siblings` is the destination block **as the engine lists it** - already
 * sorted by `order`, then `createdAt`, then `id` - with the moved row itself
 * removed, so the arrangement this produces is simply that array with the row
 * put on one end. Every position in the block is then stated outright rather
 * than left to the engine's `normalize` pass, because the two would have to
 * agree about a block the moved row is still inside while it runs: normalizing
 * `[A, B, C]` and then writing `A` at `2` puts it level with `C`, and the tie
 * goes to whichever row was created first. Stating the whole arrangement cannot
 * tie.
 *
 * Only rows whose stored `order` actually changes get an entry - the rule
 * `reorder-math.ts` follows for a drag, and what keeps a move inside a large
 * collection from rewriting every row in it. The moved row is always written:
 * it is the one carrying the destination owner, which is the move.
 *
 * The scope it *left* keeps a gap where it was (the rows after it are not
 * renumbered). That is invisible - display order reads the column's relative
 * values, never its density - and closing it would double the batch for
 * nothing.
 */
export function moveBatch(params: {
	type: "collection" | "request";
	movedId: string;
	position: "first" | "last";
	/** The destination's own key: `parentId` (null = the top level) or `collectionId`. */
	owner: Record<string, unknown>;
	siblings: readonly OrderedSibling[];
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
		moves.push({ type, id: row.id, order: index + offset });
	});
	return { moves };
}

/** A destination row, narrowed to what a move has to know about it. */
interface OrderedSibling {
	id: string;
	order?: number;
}

/**
 * The rows of a `GET /requests?collectionId=` answer, in the order it lists
 * them - which is the order the tree displays, since the engine sorts every
 * list read by the same three keys the renderer's comparator uses.
 */
export function readOrderedSiblings(value: unknown): OrderedSibling[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is OrderedSibling =>
			!!row && typeof row === "object" && typeof (row as OrderedSibling).id === "string"
	);
}
