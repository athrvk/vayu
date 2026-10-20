/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file sibling-order.ts
 * @brief A collection's children as one list: its sub-collections and its
 *        requests, in the order the sidebar shows them and a recursive run
 *        walks them (#2535).
 *
 * The third copy of the rule, beside the engine's
 * (`engine/include/vayu/db/sibling_order.hpp`) and the renderer's
 * (`compareTreeOrder`, `app/src/types/domain.ts`). The main process cannot
 * import the renderer's source (`rootDir: "electron"`), so this one is pinned
 * to the other two by the fixtures they already share:
 * `sibling-order.conformance.test.ts` replays
 * `engine/tests/fixtures/tree-order-conformance.json` and
 * `recursive-run-order-conformance.json` against it.
 */

/** Which table a sibling is a row of - and the `type` a `POST /reorder` move names it by. */
export type SiblingKind = "collection" | "request";

/** A collection or request row as the engine serializes it, narrowed to what sorts it. */
export interface OrderedRow {
	id: string;
	order?: number;
	/** Epoch milliseconds, the engine's own column; never the renderer's ISO string. */
	createdAt?: number;
}

/** One child of a parent, tagged with its kind. */
export type Sibling<F extends OrderedRow, R extends OrderedRow> =
	(F & { kind: "collection" }) | (R & { kind: "request" });

/** Rank on an `order` tie: a sub-collection sorts before a request. */
const KIND_RANK: Record<SiblingKind, number> = { collection: 0, request: 1 };

/**
 * `order`, then kind, then `createdAt`, then `id` byte-wise (SQLite BINARY,
 * hence `<` and not `localeCompare`). `GET /collections` and `GET /requests`
 * each sort their own kind by the other three keys, but neither list knows the
 * other exists, so a parent's sibling order is only ever the merge.
 */
export function compareSiblings(
	a: OrderedRow & { kind: SiblingKind },
	b: OrderedRow & { kind: SiblingKind }
): number {
	const orderDiff = (a.order ?? 0) - (b.order ?? 0);
	if (orderDiff !== 0) return orderDiff;
	const kindDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
	if (kindDiff !== 0) return kindDiff;
	const timeDiff = (a.createdAt ?? 0) - (b.createdAt ?? 0);
	if (timeDiff !== 0) return timeDiff;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/** One parent's sub-collections and requests as its sibling list. Neither input needs to be sorted. */
export function mergeSiblings<F extends OrderedRow, R extends OrderedRow>(
	folders: readonly F[],
	requests: readonly R[]
): Array<Sibling<F, R>> {
	const children: Array<Sibling<F, R>> = [
		...folders.map((row) => ({ ...row, kind: "collection" as const })),
		...requests.map((row) => ({ ...row, kind: "request" as const })),
	];
	return children.sort(compareSiblings);
}

/**
 * The rows of a `GET /requests?collectionId=` answer that carry an id, each
 * kept whole - a caller reads more of the row than its ordering keys.
 */
export function readRequestRows(value: unknown): Array<OrderedRow & Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is OrderedRow & Record<string, unknown> =>
			!!row && typeof row === "object" && typeof (row as OrderedRow).id === "string"
	);
}
