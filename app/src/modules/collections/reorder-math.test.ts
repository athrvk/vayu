/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The arithmetic behind a drop (issue #365).
 *
 * Node environment on purpose - the module is pure, and the point of extracting
 * it was that a gesture's *result* can be pinned without a gesture.
 *
 * Each test states the arrangement it expects rather than the move list, where
 * the two can differ: a plan is correct if replaying it over the siblings
 * produces the intended order, and `applyPlan` below is that replay. Asserting
 * only the raw moves would let an off-by-one in the shift range pass as long as
 * the numbers looked plausible.
 */

import { describe, it, expect } from "vitest";
import { planCollectionMove, planRequestMove, isEmptyPlan, type OrderedRow } from "./reorder-math";
import type { ReorderRequest } from "@/types";

/** A row at an explicit position. */
const row = (id: string, order: number): OrderedRow => ({ id, order });

/** The legacy shape: every row created before explicit orders existed sits at 0. */
const legacy = (...ids: string[]): OrderedRow[] => ids.map((id) => ({ id, order: 0 }));

/** A dense list, the shape a normalized scope has. */
const dense = (...ids: string[]): OrderedRow[] => ids.map((id, index) => row(id, index));

/**
 * Replays a plan the way the engine does - normalize each named scope to
 * `0..n-1` in display order, then apply the moves - and returns the resulting
 * ids per scope, in display order.
 *
 * Scopes are keyed by their owner id (`""` for the root collections), which is
 * how both entry shapes name one.
 */
function applyPlan(
	plan: ReorderRequest,
	initial: Record<string, readonly OrderedRow[]>
): Record<string, string[]> {
	const scopes = new Map<string, OrderedRow[]>();
	for (const [key, rows] of Object.entries(initial)) {
		scopes.set(
			key,
			rows.map((r) => ({ ...r }))
		);
	}
	const scopeKey = (entry: { parentId?: string | null; collectionId?: string }) =>
		entry.collectionId ?? entry.parentId ?? "";

	for (const scope of plan.normalize) {
		const rows = scopes.get(scopeKey(scope));
		if (!rows) throw new Error(`plan normalizes an unknown scope ${JSON.stringify(scope)}`);
		rows.forEach((r, index) => (r.order = index));
	}
	for (const move of plan.moves) {
		const owner =
			"collectionId" in move
				? move.collectionId
				: "parentId" in move
					? move.parentId
					: undefined;
		let current: OrderedRow | undefined;
		for (const [key, rows] of scopes) {
			const found = rows.find((r) => r.id === move.id);
			if (!found) continue;
			current = found;
			if (owner !== undefined && key !== (owner ?? "")) {
				scopes.set(
					key,
					rows.filter((r) => r.id !== move.id)
				);
				scopes.get(owner ?? "")!.push(found);
			}
			break;
		}
		if (!current) throw new Error(`plan moves an unknown row ${move.id}`);
		current.order = move.order;
	}

	const out: Record<string, string[]> = {};
	for (const [key, rows] of scopes) {
		out[key] = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((r) => r.id);
	}
	return out;
}

describe("planRequestMove within one collection", () => {
	const from = { scope: { collectionId: "col_a" }, siblings: dense("a", "b", "c", "d") };

	it("writes only the rows between the two positions", () => {
		const plan = planRequestMove({ movedId: "d", from, to: from, toIndex: 1 });

		// a stays at 0; b, c and d shift. Reverting the shift range to "every
		// sibling" turns this into 4.
		expect(plan.moves).toHaveLength(3);
		expect(plan.normalize).toEqual([]);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["a", "d", "b", "c"]);
	});

	it("writes exactly two rows for an adjacent swap", () => {
		const plan = planRequestMove({ movedId: "a", from, to: from, toIndex: 1 });

		expect(plan.moves).toHaveLength(2);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "a", "c", "d"]);
	});

	it("moves a row to the end", () => {
		const plan = planRequestMove({ movedId: "a", from, to: from, toIndex: 3 });
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "c", "d", "a"]);
	});

	it("plans nothing when the row lands back on its own slot", () => {
		const plan = planRequestMove({ movedId: "b", from, to: from, toIndex: 1 });
		expect(isEmptyPlan(plan)).toBe(true);
	});

	it("clamps a drop past the end of the list", () => {
		const plan = planRequestMove({ movedId: "a", from, to: from, toIndex: 99 });
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "c", "d", "a"]);
	});

	it("rejects a fractional index rather than silently truncating it", () => {
		expect(() => planRequestMove({ movedId: "a", from, to: from, toIndex: 1.5 })).toThrow(
			/integer/
		);
	});

	it("rejects a row that is not in the list it claims to be in", () => {
		expect(() => planRequestMove({ movedId: "zz", from, to: from, toIndex: 0 })).toThrow(/zz/);
	});
});

describe("planRequestMove over a legacy all-zeros collection", () => {
	// The primary case: nothing has ever been dragged, so every row is at 0 and
	// its displayed position exists only in the sort's createdAt/id tiebreak.
	const from = { scope: { collectionId: "col_a" }, siblings: legacy("a", "b", "c") };

	it("normalizes the collection before the move", () => {
		const plan = planRequestMove({ movedId: "c", from, to: from, toIndex: 0 });

		expect(plan.normalize).toEqual([{ type: "request", collectionId: "col_a" }]);
		// Without the normalize the shifts below land on rows that all read 0,
		// and the arrangement is a tie lottery instead of the intended order.
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["c", "a", "b"]);
	});

	it("normalizes without a redundant move when the row does not actually move", () => {
		const plan = planRequestMove({ movedId: "a", from, to: from, toIndex: 0 });

		expect(plan.moves).toEqual([]);
		expect(plan.normalize).toHaveLength(1);
		expect(isEmptyPlan(plan)).toBe(false);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["a", "b", "c"]);
	});

	it("does not normalize a list that is already dense", () => {
		const alreadyDense = { scope: { collectionId: "col_a" }, siblings: dense("a", "b", "c") };
		const plan = planRequestMove({
			movedId: "c",
			from: alreadyDense,
			to: alreadyDense,
			toIndex: 0,
		});
		expect(plan.normalize).toEqual([]);
	});
});

describe("planRequestMove across collections", () => {
	const from = { scope: { collectionId: "col_a" }, siblings: dense("a", "b", "c") };
	const to = { scope: { collectionId: "col_b" }, siblings: dense("x", "y") };

	it("closes the gap in the source and opens one in the target", () => {
		const plan = planRequestMove({ movedId: "a", from, to, toIndex: 1 });

		const result = applyPlan(plan, { col_a: from.siblings, col_b: to.siblings });
		expect(result.col_a).toEqual(["b", "c"]);
		expect(result.col_b).toEqual(["x", "a", "y"]);
	});

	it("stamps the destination collection on the moved row and on no other", () => {
		const plan = planRequestMove({ movedId: "a", from, to, toIndex: 0 });

		const owners = plan.moves.filter((m) => "collectionId" in m && m.collectionId);
		expect(owners).toEqual([{ type: "request", id: "a", order: 0, collectionId: "col_b" }]);
	});

	it("appends when the drop lands past the end of the target", () => {
		const plan = planRequestMove({ movedId: "a", from, to, toIndex: 5 });

		const result = applyPlan(plan, { col_a: from.siblings, col_b: to.siblings });
		expect(result.col_b).toEqual(["x", "y", "a"]);
	});

	it("normalizes both sides when both are legacy", () => {
		const legacyFrom = { scope: { collectionId: "col_a" }, siblings: legacy("a", "b") };
		const legacyTo = { scope: { collectionId: "col_b" }, siblings: legacy("x", "y") };
		const plan = planRequestMove({ movedId: "a", from: legacyFrom, to: legacyTo, toIndex: 1 });

		expect(plan.normalize).toEqual([
			{ type: "request", collectionId: "col_a" },
			{ type: "request", collectionId: "col_b" },
		]);
		const result = applyPlan(plan, { col_a: legacyFrom.siblings, col_b: legacyTo.siblings });
		expect(result.col_a).toEqual(["b"]);
		expect(result.col_b).toEqual(["x", "a", "y"]);
	});

	it("rejects a target that already holds the row", () => {
		const confused = { scope: { collectionId: "col_b" }, siblings: dense("a") };
		expect(() => planRequestMove({ movedId: "a", from, to: confused, toIndex: 0 })).toThrow(
			/already contains/
		);
	});
});

describe("planCollectionMove", () => {
	it("moves a folder among its siblings", () => {
		const from = { scope: { parentId: "col_p" }, siblings: dense("f1", "f2", "f3") };
		const plan = planCollectionMove({ movedId: "f3", from, to: from, toIndex: 0 });

		expect(applyPlan(plan, { col_p: from.siblings }).col_p).toEqual(["f3", "f1", "f2"]);
	});

	it("moves a folder out to the root, which is parentId null", () => {
		const from = { scope: { parentId: "col_p" }, siblings: dense("f1", "f2") };
		const to = { scope: { parentId: null }, siblings: dense("r1", "r2") };
		const plan = planCollectionMove({ movedId: "f1", from, to, toIndex: 0 });

		expect(plan.moves).toContainEqual({
			type: "collection",
			id: "f1",
			order: 0,
			parentId: null,
		});
		const result = applyPlan(plan, { col_p: from.siblings, "": to.siblings });
		expect(result[""]).toEqual(["f1", "r1", "r2"]);
		expect(result.col_p).toEqual(["f2"]);
	});

	it("normalizes the root scope as `parentId: null`, not as a missing key", () => {
		const roots = { scope: { parentId: null }, siblings: legacy("r1", "r2", "r3") };
		const plan = planCollectionMove({ movedId: "r3", from: roots, to: roots, toIndex: 0 });

		expect(plan.normalize).toEqual([{ type: "collection", parentId: null }]);
	});

	it("keeps the folder block independent of the request block", () => {
		// Folders and requests are two separate ordered runs rendered
		// folders-first, so a folder's indices are its own - a collection at
		// index 1 among two folders is not "below" the requests underneath them.
		const folders = { scope: { parentId: "col_p" }, siblings: dense("f1", "f2") };
		const plan = planCollectionMove({ movedId: "f2", from: folders, to: folders, toIndex: 0 });

		expect(plan.moves.every((m) => m.type === "collection")).toBe(true);
		expect(plan.moves.map((m) => m.order)).toEqual([0, 1]);
	});
});
