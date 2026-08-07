/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tree walks, and the cycle that used to freeze the window.
 *
 * **Why the step budgets.** Without a termination guard these tests would spin
 * forever and take the whole vitest run with them - a synchronous loop never
 * yields, so the per-test timeout can never fire. Each walk is therefore given a
 * fixture that counts the one thing it does exactly once per step and throws
 * past a budget no correct walk can reach: `parentId` reads for the ancestor
 * walk, and a request lookup per visited collection for the descendant walk.
 * That turns "hangs" into "fails with a message" - mutation-check by deleting
 * the `seen` set in `walkAncestors` or the `visited` set in
 * `collectDescendantEntityIds`, and these fail in milliseconds rather than
 * stalling.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	walkAncestors,
	isDescendant,
	collectDescendantEntityIds,
	type TreeNode,
} from "./tree-utils";

/** No fixture chain here is longer than four, so twenty is unreachable. */
const STEP_BUDGET = 20;

let steps = 0;

beforeEach(() => {
	steps = 0;
});

/**
 * The nodes, with every `parentId` read counted.
 *
 * A getter rather than a wrapped array method, because the walks are free to
 * look their nodes up however they like (`Array.find`, a `Map`) - what no
 * terminating walk can do is read one node's parent an unbounded number of
 * times.
 */
function budgeted<T extends TreeNode>(nodes: T[]): T[] {
	return nodes.map((node) => {
		const { parentId } = node;
		return Object.defineProperty({ ...node }, "parentId", {
			enumerable: true,
			get() {
				if (++steps > STEP_BUDGET) {
					throw new Error(
						`more than ${STEP_BUDGET} parentId reads - the walk is not terminating`
					);
				}
				return parentId;
			},
		}) as T;
	});
}

const named = (id: string, parentId?: string) => ({ id, name: id, parentId });

describe("walkAncestors", () => {
	it("returns the chain root first, inclusive of the start node", () => {
		const nodes = budgeted([named("leaf", "mid"), named("mid", "root"), named("root")]);

		expect(walkAncestors("leaf", nodes).map((n) => n.id)).toEqual(["root", "mid", "leaf"]);
	});

	it("terminates on a two-node cycle, visiting each node once", () => {
		const nodes = budgeted([named("a", "b"), named("b", "a")]);

		// Not deduplication: both nodes are still reported, in the order the
		// override rules downstream depend on. Only the *repeat* stops the walk.
		expect(walkAncestors("a", nodes).map((n) => n.id)).toEqual(["b", "a"]);
	});

	it("terminates on a node that is its own parent", () => {
		const nodes = budgeted([named("self", "self")]);

		expect(walkAncestors("self", nodes).map((n) => n.id)).toEqual(["self"]);
	});

	it("stops at an unloaded parent instead of inventing one", () => {
		const nodes = budgeted([named("orphan", "gone")]);

		expect(walkAncestors("orphan", nodes).map((n) => n.id)).toEqual(["orphan"]);
	});

	it("returns nothing for a start id that is not loaded", () => {
		expect(walkAncestors("ghost", budgeted([named("root")]))).toEqual([]);
	});

	it("stays well under the budget on an honest chain", () => {
		// Guards the guard: a budget the correct walk could trip would make the
		// cycle cases above pass for the wrong reason.
		const nodes = budgeted([named("leaf", "root"), named("root")]);

		walkAncestors("leaf", nodes);

		expect(steps).toBeGreaterThan(0);
		expect(steps).toBeLessThanOrEqual(STEP_BUDGET);
	});
});

describe("isDescendant", () => {
	const nodes = () =>
		budgeted([named("leaf", "mid"), named("mid", "root"), named("root"), named("other")]);

	it("is true through any depth of nesting", () => {
		expect(isDescendant("leaf", "root", nodes())).toBe(true);
		expect(isDescendant("mid", "root", nodes())).toBe(true);
	});

	it("is false upwards, sideways, and for a node against itself", () => {
		expect(isDescendant("root", "leaf", nodes())).toBe(false);
		expect(isDescendant("other", "root", nodes())).toBe(false);
		expect(isDescendant("root", "root", nodes())).toBe(false);
	});

	it("terminates on a cycle rather than looping", () => {
		expect(isDescendant("a", "outside", budgeted([named("a", "b"), named("b", "a")]))).toBe(
			false
		);
	});
});

describe("collectDescendantEntityIds", () => {
	// root > mid > leaf, plus an unrelated branch that must stay untouched.
	const tree = () =>
		budgeted([named("root"), named("mid", "root"), named("leaf", "mid"), named("elsewhere")]);
	const requests: Record<string, string[]> = {
		root: ["r-root"],
		mid: ["r-mid"],
		leaf: ["r-leaf-1", "r-leaf-2"],
		elsewhere: ["r-elsewhere"],
	};
	/**
	 * One call per collection the walk visits - the descendant walk's own step
	 * counter, since it reads each `parentId` once while indexing and then never
	 * again.
	 */
	const requestIdsIn = (id: string) => {
		if (++steps > STEP_BUDGET) {
			throw new Error(
				`more than ${STEP_BUDGET} collections visited - the walk is not terminating`
			);
		}
		return requests[id] ?? [];
	};

	it("collects the collection, every descendant folder, and all their requests", () => {
		const affected = collectDescendantEntityIds("root", tree(), requestIdsIn);

		// The nested-folder case: `leaf` is two levels down, and its requests are
		// the ones a single-level cascade would leave with stale tabs open.
		expect([...affected].sort()).toEqual(
			["leaf", "mid", "r-leaf-1", "r-leaf-2", "r-mid", "r-root", "root"].sort()
		);
	});

	it("leaves an unrelated branch alone", () => {
		const affected = collectDescendantEntityIds("mid", tree(), requestIdsIn);

		expect(affected.has("elsewhere")).toBe(false);
		expect(affected.has("r-elsewhere")).toBe(false);
		expect(affected.has("root")).toBe(false);
		expect(affected.has("r-root")).toBe(false);
	});

	it("terminates when the subtree loops back on itself", () => {
		// `b` is a child of `a` and `a` a child of `b`: the pre-existing BFS pushed
		// each of them again on every visit and never emptied its stack.
		const affected = collectDescendantEntityIds(
			"a",
			budgeted([named("a", "b"), named("b", "a")]),
			requestIdsIn
		);

		expect([...affected].sort()).toEqual(["a", "b"]);
		// Guards the guard: the counter above did run, so a budget that could
		// never trip is not what made this pass.
		expect(steps).toBeGreaterThan(0);
	});

	it("returns just the collection when it holds nothing", () => {
		expect([...collectDescendantEntityIds("elsewhere", tree(), () => [])]).toEqual([
			"elsewhere",
		]);
	});
});
