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
 *    position lives only in the sort's `createdAt`/`id` tiebreak - there are no
 *    slots to shift into. `normalize` materializes that displayed order as
 *    `0..n-1` in the same batch, before the moves land, which is why nothing
 *    visibly jumps on the first drop into a legacy collection.
 *
 * Callers pass **siblings in the order the tree displays them** (already sorted
 * with `compareTreeOrder`), which is the order the engine's normalization
 * produces - the two must agree or a normalized drop lands somewhere the user
 * did not point at. Subfolders and requests are separate ordered blocks
 * rendered folders-first, so a caller passes one block, never both: the `order`
 * column cannot interleave a request between two folders.
 */

import type { ReorderMove, ReorderNormalize, ReorderRequest } from "@/types";

/** The minimum a plan needs from a sibling row. `Collection`/`Request` satisfy it. */
export interface OrderedRow {
	id: string;
	order?: number;
}

/** Where a collection lives: under a parent, or `null` at the root. */
export interface CollectionScope {
	parentId: string | null;
}

/** Where a request lives. */
export interface RequestScope {
	collectionId: string;
}

/** One end of a move: the scope, and the rows in it as the tree displays them. */
interface Side<TScope> {
	scope: TScope;
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

/**
 * The whole computation, once, over positions - the two public wrappers only
 * differ in which owner field they stamp on the moved row.
 *
 * `makeMove` builds one entry for a row that is *not* changing owner;
 * `makeOwnerMove` builds the entry for the moved row itself, carrying the
 * destination scope.
 */
function planMove<TScope>(params: {
	movedId: string;
	from: Side<TScope>;
	to: Side<TScope>;
	toIndex: number;
	sameScope: (a: TScope, b: TScope) => boolean;
	normalizeOf: (scope: TScope) => ReorderNormalize;
	makeMove: (id: string, order: number) => ReorderMove;
	makeOwnerMove: (id: string, order: number, scope: TScope) => ReorderMove;
}): ReorderRequest {
	const { movedId, from, to, sameScope, normalizeOf, makeMove, makeOwnerMove } = params;

	const fromIndex = indexOf(from.siblings, movedId);
	if (fromIndex < 0) {
		throw new Error(`Reorder source does not contain '${movedId}'`);
	}

	if (sameScope(from.scope, to.scope)) {
		const toIndex = clamp(params.toIndex, from.siblings.length - 1);
		const normalize = isDense(from.siblings) ? [] : [normalizeOf(from.scope)];
		// A drop back onto the row's own slot moves nothing. It can still be
		// worth a round trip: if the list was not dense, the normalization is
		// the whole point, and it lands without a redundant move restating a
		// position the renumber already assigns.
		if (toIndex === fromIndex) {
			return { moves: [], normalize };
		}

		// After normalization every row sits at its displayed index, so the
		// resulting arrangement is just the array with the row spliced across -
		// and the rows that moved are exactly the ones between the two indices.
		const next = from.siblings.filter((row) => row.id !== movedId);
		next.splice(toIndex, 0, from.siblings[fromIndex]);

		const moves: ReorderMove[] = [];
		for (let i = Math.min(fromIndex, toIndex); i <= Math.max(fromIndex, toIndex); i++) {
			moves.push(makeMove(next[i].id, i));
		}
		return { moves, normalize };
	}

	if (indexOf(to.siblings, movedId) >= 0) {
		throw new Error(`Reorder target already contains '${movedId}'`);
	}
	const toIndex = clamp(params.toIndex, to.siblings.length);

	const normalize: ReorderNormalize[] = [];
	if (!isDense(from.siblings)) normalize.push(normalizeOf(from.scope));
	if (!isDense(to.siblings)) normalize.push(normalizeOf(to.scope));

	const moves: ReorderMove[] = [];
	// The source closes the gap the row left; the destination opens one for it.
	// Rows before either index keep the index they already have.
	for (let i = fromIndex + 1; i < from.siblings.length; i++) {
		moves.push(makeMove(from.siblings[i].id, i - 1));
	}
	for (let i = toIndex; i < to.siblings.length; i++) {
		moves.push(makeMove(to.siblings[i].id, i + 1));
	}
	moves.push(makeOwnerMove(movedId, toIndex, to.scope));
	return { moves, normalize };
}

/**
 * The batch that moves a collection to `toIndex` among the children of
 * `to.scope`.
 *
 * `from` and `to` may name the same parent (a reorder) or different ones (a
 * move, including to and from the root, which is `parentId: null`).
 */
export function planCollectionMove(params: {
	movedId: string;
	from: Side<CollectionScope>;
	to: Side<CollectionScope>;
	toIndex: number;
}): ReorderRequest {
	return planMove<CollectionScope>({
		...params,
		sameScope: (a, b) => a.parentId === b.parentId,
		normalizeOf: (scope) => ({ type: "collection", parentId: scope.parentId }),
		makeMove: (id, order) => ({ type: "collection", id, order }),
		makeOwnerMove: (id, order, scope) => ({
			type: "collection",
			id,
			order,
			parentId: scope.parentId,
		}),
	});
}

/**
 * The batch that moves a request to `toIndex` among the requests of
 * `to.scope` - the same shape as `planCollectionMove`, over the other block.
 */
export function planRequestMove(params: {
	movedId: string;
	from: Side<RequestScope>;
	to: Side<RequestScope>;
	toIndex: number;
}): ReorderRequest {
	return planMove<RequestScope>({
		...params,
		sameScope: (a, b) => a.collectionId === b.collectionId,
		normalizeOf: (scope) => ({ type: "request", collectionId: scope.collectionId }),
		makeMove: (id, order) => ({ type: "request", id, order }),
		makeOwnerMove: (id, order, scope) => ({
			type: "request",
			id,
			order,
			collectionId: scope.collectionId,
		}),
	});
}

/** True when a plan would write nothing, so the caller can skip the round trip. */
export function isEmptyPlan(plan: ReorderRequest): boolean {
	return plan.moves.length === 0 && plan.normalize.length === 0;
}
