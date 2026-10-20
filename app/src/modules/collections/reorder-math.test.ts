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
 *
 * A parent's children are its sub-folders and its requests in one list
 * (#2535), so the fixtures mix the two kinds wherever the kind could matter: a
 * displaced sibling has to be written as the kind it is.
 */

import { describe, it, expect } from "vitest";
import { planMove, isEmptyPlan, type OrderedRow, type SiblingScope } from "./reorder-math";
import type { ReorderRequest, TreeRowKind } from "@/types";

/** A row at an explicit position; an `f` prefix marks a folder, anything else a request. */
const kindOf = (id: string): TreeRowKind => (id.startsWith("f") ? "collection" : "request");
const row = (id: string, order: number): OrderedRow => ({ id, kind: kindOf(id), order });

/** The legacy shape: every row created before explicit orders existed sits at 0. */
const legacy = (...ids: string[]): OrderedRow[] => ids.map((id) => row(id, 0));

/** A dense list, the shape a normalized parent has. */
const dense = (...ids: string[]): OrderedRow[] => ids.map((id, index) => row(id, index));

const scope = (parentId: string | null, siblings: OrderedRow[]): SiblingScope => ({
	parentId,
	siblings,
});

/**
 * Replays a plan the way the engine does - normalize each named parent to
 * `0..n-1` in display order, then apply the moves - and returns the resulting
 * ids per parent, in display order.
 *
 * Parents are keyed by id (`""` for the top level). A move's owner field is
 * the one its type carries, so a plan that stamped a folder's parent on a
 * request (or the reverse) would land the row in the wrong list here.
 */
function applyPlan(
	plan: ReorderRequest,
	initial: Record<string, readonly OrderedRow[]>
): Record<string, string[]> {
	const parents = new Map<string, OrderedRow[]>();
	for (const [key, rows] of Object.entries(initial)) {
		parents.set(
			key,
			rows.map((r) => ({ ...r }))
		);
	}

	for (const entry of plan.normalize) {
		const rows = parents.get(entry.parentId ?? "");
		if (!rows) throw new Error(`plan normalizes an unknown parent ${JSON.stringify(entry)}`);
		rows.forEach((r, index) => (r.order = index));
	}
	for (const move of plan.moves) {
		const owner =
			move.type === "request"
				? move.collectionId
				: "parentId" in move
					? (move.parentId ?? "")
					: undefined;
		let current: OrderedRow | undefined;
		for (const [key, rows] of parents) {
			const found = rows.find((r) => r.id === move.id);
			if (!found) continue;
			if (found.kind !== move.type) {
				throw new Error(`plan writes ${move.id} as a ${move.type}, it is a ${found.kind}`);
			}
			current = found;
			if (owner !== undefined && key !== owner) {
				parents.set(
					key,
					rows.filter((r) => r.id !== move.id)
				);
				parents.get(owner)!.push(found);
			}
			break;
		}
		if (!current) throw new Error(`plan moves an unknown row ${move.id}`);
		current.order = move.order;
	}

	const out: Record<string, string[]> = {};
	for (const [key, rows] of parents) {
		out[key] = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((r) => r.id);
	}
	return out;
}

describe("planMove within one parent", () => {
	const from = scope("col_a", dense("a", "b", "c", "d"));

	it("writes only the rows between the two positions", () => {
		const plan = planMove({ movedId: "d", from, to: from, toIndex: 1 });

		// a stays at 0; b, c and d shift. Reverting the shift range to "every
		// sibling" turns this into 4.
		expect(plan.moves).toHaveLength(3);
		expect(plan.normalize).toEqual([]);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["a", "d", "b", "c"]);
	});

	it("writes exactly two rows for an adjacent swap", () => {
		const plan = planMove({ movedId: "a", from, to: from, toIndex: 1 });

		expect(plan.moves).toHaveLength(2);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "a", "c", "d"]);
	});

	it("moves a row to the end", () => {
		const plan = planMove({ movedId: "a", from, to: from, toIndex: 3 });
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "c", "d", "a"]);
	});

	it("plans nothing when the row lands back on its own slot", () => {
		const plan = planMove({ movedId: "b", from, to: from, toIndex: 1 });
		expect(isEmptyPlan(plan)).toBe(true);
	});

	it("clamps a drop past the end of the list", () => {
		const plan = planMove({ movedId: "a", from, to: from, toIndex: 99 });
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["b", "c", "d", "a"]);
	});

	it("rejects a fractional index rather than silently truncating it", () => {
		expect(() => planMove({ movedId: "a", from, to: from, toIndex: 1.5 })).toThrow(/integer/);
	});

	it("rejects a row that is not in the list it claims to be in", () => {
		expect(() => planMove({ movedId: "zz", from, to: from, toIndex: 0 })).toThrow(/zz/);
	});
});

describe("planMove over folders and requests in one list", () => {
	// f1, r1, f2, r2: the shape a Postman import with interleaved items leaves.
	const mixed = scope("col_p", dense("f1", "r1", "f2", "r2"));

	it("puts a request between two folders", () => {
		const plan = planMove({ movedId: "r2", from: mixed, to: mixed, toIndex: 1 });

		expect(applyPlan(plan, { col_p: mixed.siblings }).col_p).toEqual(["f1", "r2", "r1", "f2"]);
	});

	it("writes every displaced sibling as its own kind", () => {
		const plan = planMove({ movedId: "r2", from: mixed, to: mixed, toIndex: 0 });

		expect(plan.moves).toEqual([
			{ type: "request", id: "r2", order: 0 },
			{ type: "collection", id: "f1", order: 1 },
			{ type: "request", id: "r1", order: 2 },
			{ type: "collection", id: "f2", order: 3 },
		]);
	});

	it("moves a folder below a request", () => {
		const plan = planMove({ movedId: "f1", from: mixed, to: mixed, toIndex: 1 });

		expect(plan.moves).toEqual([
			{ type: "request", id: "r1", order: 0 },
			{ type: "collection", id: "f1", order: 1 },
		]);
	});

	it("normalizes the parent once, for both kinds", () => {
		// Pre-#2535 rows of both kinds tied at 0, displayed folders first.
		const tied = scope("col_p", legacy("f1", "f2", "r1", "r2"));
		const plan = planMove({ movedId: "r1", from: tied, to: tied, toIndex: 0 });

		expect(plan.normalize).toEqual([{ parentId: "col_p" }]);
		expect(applyPlan(plan, { col_p: tied.siblings }).col_p).toEqual(["r1", "f1", "f2", "r2"]);
	});
});

describe("planMove over a legacy all-zeros collection", () => {
	// The primary case: nothing has ever been dragged, so every row is at 0 and
	// its displayed position exists only in the sort's tiebreaks.
	const from = scope("col_a", legacy("a", "b", "c"));

	it("normalizes the collection before the move", () => {
		const plan = planMove({ movedId: "c", from, to: from, toIndex: 0 });

		expect(plan.normalize).toEqual([{ parentId: "col_a" }]);
		// Without the normalize the shifts below land on rows that all read 0,
		// and the arrangement is a tie lottery instead of the intended order.
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["c", "a", "b"]);
	});

	it("normalizes without a redundant move when the row does not actually move", () => {
		const plan = planMove({ movedId: "a", from, to: from, toIndex: 0 });

		expect(plan.moves).toEqual([]);
		expect(plan.normalize).toHaveLength(1);
		expect(isEmptyPlan(plan)).toBe(false);
		expect(applyPlan(plan, { col_a: from.siblings }).col_a).toEqual(["a", "b", "c"]);
	});

	it("does not normalize a list that is already dense", () => {
		const alreadyDense = scope("col_a", dense("a", "b", "c"));
		const plan = planMove({ movedId: "c", from: alreadyDense, to: alreadyDense, toIndex: 0 });
		expect(plan.normalize).toEqual([]);
	});
});

describe("planMove across parents", () => {
	const from = scope("col_a", dense("a", "b", "c"));
	const to = scope("col_b", dense("x", "f_y"));

	it("closes the gap in the source and opens one in the target", () => {
		const plan = planMove({ movedId: "a", from, to, toIndex: 1 });

		const result = applyPlan(plan, { col_a: from.siblings, col_b: to.siblings });
		expect(result.col_a).toEqual(["b", "c"]);
		expect(result.col_b).toEqual(["x", "a", "f_y"]);
	});

	it("stamps the destination on the moved row and on no other", () => {
		const plan = planMove({ movedId: "a", from, to, toIndex: 0 });

		const owners = plan.moves.filter((m) => "collectionId" in m || "parentId" in m);
		expect(owners).toEqual([{ type: "request", id: "a", order: 0, collectionId: "col_b" }]);
	});

	it("appends after both kinds at the destination's length", () => {
		const plan = planMove({ movedId: "a", from, to, toIndex: to.siblings.length });

		const result = applyPlan(plan, { col_a: from.siblings, col_b: to.siblings });
		expect(result.col_b).toEqual(["x", "f_y", "a"]);
		// An append displaces nothing at the destination.
		expect(plan.moves.filter((m) => m.id === "x" || m.id === "f_y")).toEqual([]);
	});

	it("appends when the drop lands past the end of the target", () => {
		const plan = planMove({ movedId: "a", from, to, toIndex: 5 });

		const result = applyPlan(plan, { col_a: from.siblings, col_b: to.siblings });
		expect(result.col_b).toEqual(["x", "f_y", "a"]);
	});

	it("normalizes both parents when both are legacy", () => {
		const legacyFrom = scope("col_a", legacy("a", "b"));
		const legacyTo = scope("col_b", legacy("x", "y"));
		const plan = planMove({ movedId: "a", from: legacyFrom, to: legacyTo, toIndex: 1 });

		expect(plan.normalize).toEqual([{ parentId: "col_a" }, { parentId: "col_b" }]);
		const result = applyPlan(plan, { col_a: legacyFrom.siblings, col_b: legacyTo.siblings });
		expect(result.col_a).toEqual(["b"]);
		expect(result.col_b).toEqual(["x", "a", "y"]);
	});

	it("rejects a target that already holds the row", () => {
		const confused = scope("col_b", dense("a"));
		expect(() => planMove({ movedId: "a", from, to: confused, toIndex: 0 })).toThrow(
			/already contains/
		);
	});

	it("refuses to move a request to the top level", () => {
		const roots = scope(null, dense("f_r1"));
		expect(() => planMove({ movedId: "a", from, to: roots, toIndex: 0 })).toThrow(/top level/);
	});
});

describe("planMove for a folder", () => {
	it("moves a folder out to the root, which is parentId null", () => {
		const from = scope("col_p", dense("f1", "f2", "r1"));
		const to = scope(null, dense("f_r1", "f_r2"));
		const plan = planMove({ movedId: "f1", from, to, toIndex: 0 });

		expect(plan.moves).toContainEqual({
			type: "collection",
			id: "f1",
			order: 0,
			parentId: null,
		});
		const result = applyPlan(plan, { col_p: from.siblings, "": to.siblings });
		expect(result[""]).toEqual(["f1", "f_r1", "f_r2"]);
		expect(result.col_p).toEqual(["f2", "r1"]);
	});

	it("normalizes the root as `parentId: null`, not as a missing key", () => {
		const roots = scope(null, legacy("f_r1", "f_r2", "f_r3"));
		const plan = planMove({ movedId: "f_r3", from: roots, to: roots, toIndex: 0 });

		expect(plan.normalize).toEqual([{ parentId: null }]);
	});
});
