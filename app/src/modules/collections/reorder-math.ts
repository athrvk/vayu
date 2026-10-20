/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The arithmetic behind a drop: which rows a move actually has to rewrite.
 *
 * A pure module with no React, no query client and no network, because the
 * interesting part of a drag interaction is this and nothing else - and it is
 * the part a jsdom test cannot reach through a gesture. The component wiring
 * (issue #367) hands it sibling lists it already has on screen and sends the
 * result straight to `POST /reorder`.
 *
 * Two rules shape everything below:
 *
 * 1. **Only rows whose position changes are written.** A drop inside a dense
 *    list shifts a contiguous run, so an adjacent swap writes two rows rather
 *    than renumbering the whole folder. The engine's batch is atomic either
 *    way; a minimal batch is what keeps a drag in a 200-request collection from
 *    being a 200-row write.
 * 2. **A list that is not already dense is normalized first.** Every row
 *    created before explicit orders existed sits at `0`, so its displayed
 *    position lives only in the sort's tiebreaks (kind, `createdAt`, `id`) -
 *    there are no slots to shift into. `normalize` materializes that displayed
 *    order as `0..n-1` in the same batch, before the moves land, which is why
 *    nothing visibly jumps on the first drop into a legacy collection.
 *
 * Callers pass **siblings in the order the tree displays them** (`childrenOf`,
 * already sorted with `compareTreeOrder`), which is the order the engine's
 * normalization produces - the two must agree or a normalized drop lands
 * somewhere the user did not point at. A parent's sub-folders and requests are
 * one list in one `order` space (#2535), so a caller passes both kinds together
 * and every displaced sibling is written as the kind it is.
 */

import type { ReorderMove, ReorderRequest, TreeRowKind } from "@/types";

/** The minimum a plan needs from a sibling row. `TreeChild` satisfies it. */
export interface OrderedRow {
	id: string;
	kind: TreeRowKind;
	order?: number;
}

/** One end of a move: the parent (`null` for the top level) and its children as displayed. */
export interface SiblingScope {
	parentId: string | null;
	siblings: readonly OrderedRow[];
}

/**
 * A list is dense when every row's stored `order` already equals its displayed
 * index. Only then can a move be expressed as a shift; anything else needs the
 * normalization pass first.
 */
function isDense(siblings: readonly OrderedRow[]): boolean {
	return siblings.every((row, index) => row.order === index);
}

/** Index of `id` in `siblings`, or -1. */
function indexOf(siblings: readonly OrderedRow[], id: string): number {
	return siblings.findIndex((row) => row.id === id);
}

/**
 * `value` confined to `[0, max]`.
 *
 * A drop index comes from a pointer position, so it is bounded by geometry the
 * caller measured rather than by the list - past the last row is a legitimate
 * gesture meaning "put it at the end", not a bug worth throwing over. An id that
 * is not in the list it claims to be in *is* a bug, and throws.
 */
function clamp(value: number, max: number): number {
	if (!Number.isInteger(value)) {
		throw new Error(`Reorder index must be an integer, got ${value}`);
	}
	return Math.max(0, Math.min(value, max));
}

/** A sibling's new position under the parent it already has. */
function shiftMove(row: OrderedRow, order: number): ReorderMove {
	return { type: row.kind, id: row.id, order };
}

/** The moved row's entry, carrying the parent it lands under. */
function ownerMove(row: OrderedRow, order: number, parentId: string | null): ReorderMove {
	if (row.kind === "collection") return { type: "collection", id: row.id, order, parentId };
	// The top level holds collections only; the engine would refuse this too,
	// but a planner bug is cheaper to read here than as a 400.
	if (parentId === null) throw new Error(`Request '${row.id}' cannot move to the top level`);
	return { type: "request", id: row.id, order, collectionId: parentId };
}

/** Within one parent: the rows between the two indices are the ones that move. */
function planWithinParent(
	scope: SiblingScope,
	fromIndex: number,
	rawToIndex: number
): ReorderRequest {
	const { siblings } = scope;
	const toIndex = clamp(rawToIndex, siblings.length - 1);
	const normalize = isDense(siblings) ? [] : [{ parentId: scope.parentId }];
	// A drop back onto the row's own slot moves nothing. It can still be worth a
	// round trip: if the list was not dense, the normalization is the whole
	// point, and it lands without a redundant move restating a position the
	// renumber already assigns.
	if (toIndex === fromIndex) return { moves: [], normalize };

	// After normalization every row sits at its displayed index, so the
	// resulting arrangement is just the array with the row spliced across - and
	// the rows that moved are exactly the ones between the two indices.
	const next = siblings.filter((_, i) => i !== fromIndex);
	next.splice(toIndex, 0, siblings[fromIndex]);

	const moves: ReorderMove[] = [];
	for (let i = Math.min(fromIndex, toIndex); i <= Math.max(fromIndex, toIndex); i++) {
		moves.push(shiftMove(next[i], i));
	}
	return { moves, normalize };
}

/** Across parents: the source closes the gap the row left, the destination opens one. */
function planAcrossParents(
	from: SiblingScope,
	to: SiblingScope,
	fromIndex: number,
	rawToIndex: number
): ReorderRequest {
	const moved = from.siblings[fromIndex];
	if (indexOf(to.siblings, moved.id) >= 0) {
		throw new Error(`Reorder target already contains '${moved.id}'`);
	}
	const toIndex = clamp(rawToIndex, to.siblings.length);

	const normalize = [from, to]
		.filter((side) => !isDense(side.siblings))
		.map((side) => ({ parentId: side.parentId }));

	// Rows before either index keep the index they already have.
	const moves: ReorderMove[] = [];
	for (let i = fromIndex + 1; i < from.siblings.length; i++) {
		moves.push(shiftMove(from.siblings[i], i - 1));
	}
	for (let i = toIndex; i < to.siblings.length; i++) {
		moves.push(shiftMove(to.siblings[i], i + 1));
	}
	moves.push(ownerMove(moved, toIndex, to.parentId));
	return { moves, normalize };
}

/**
 * The batch that moves `movedId` to `toIndex` among the children of
 * `to.parentId`, whichever kind it is.
 *
 * `from` and `to` may name the same parent (a reorder) or different ones (a
 * move, including to and from the top level, which is `parentId: null` and
 * holds collections only). `toIndex` is an index in the destination list
 * *without* the moved row, so `to.siblings.length` appends.
 */
export function planMove(params: {
	movedId: string;
	from: SiblingScope;
	to: SiblingScope;
	toIndex: number;
}): ReorderRequest {
	const { movedId, from, to, toIndex } = params;
	const fromIndex = indexOf(from.siblings, movedId);
	if (fromIndex < 0) {
		throw new Error(`Reorder source does not contain '${movedId}'`);
	}
	if (from.parentId === to.parentId) return planWithinParent(from, fromIndex, toIndex);
	return planAcrossParents(from, to, fromIndex, toIndex);
}

/** True when a plan would write nothing, so the caller can skip the round trip. */
export function isEmptyPlan(plan: ReorderRequest): boolean {
	return plan.moves.length === 0 && plan.normalize.length === 0;
}
