/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A `parentId` cycle must not hang the renderer (issue #227).
 *
 * The chain walk runs inside a `useMemo`, so an unterminated walk is not a
 * wrong preview - it is a synchronous loop on the render thread, i.e. a frozen
 * window. The engine rejects cycles on write (#79), so reaching this needs a
 * database that already went bad; the guard is three lines and the failure it
 * prevents cannot be recovered from without killing the app.
 *
 * The walk itself now lives in `modules/collections/tree-utils` and is unit
 * tested there; what these cover is that the hook still gets the terminating
 * one, and that the chain it produces keeps the leaf-over-root override order
 * the preview depends on.
 *
 * **Why the step budget.** Without the guard this test would spin forever and
 * take the whole vitest run with it - a synchronous loop never yields, so the
 * per-test timeout can never fire. Each fixture collection therefore counts
 * reads of its own `parentId` - exactly one per step of the walk, whatever it
 * uses to look nodes up - and throws past a budget no correct walk can reach,
 * which turns "hangs" into "fails with a message". Mutation-check the guard by
 * deleting the `seen` set: these tests fail in milliseconds, they do not stall.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Collection } from "@/types";

const globals = { variables: {} as Record<string, unknown> };
let collections: Collection[] = [];
const environments: Array<Record<string, unknown>> = [];
const session = { activeEnvironmentId: null as string | null };

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useEnvironmentsQuery: () => ({ data: environments }),
}));
vi.mock("@/stores", () => ({
	useSessionStore: () => session,
}));

import { useVariableResolver } from "./useVariableResolver";

/** No chain in these fixtures is longer than three, so ten is unreachable. */
const LOOKUP_BUDGET = 10;

let lookups = 0;

/**
 * The collections, each counting reads of its own `parentId`.
 *
 * One read per step of the walk, so an unterminated walk trips the budget no
 * matter how the walk looks its nodes up - which a counter wrapped around
 * `Array.find` did not survive, having silently stopped counting the day the
 * walk moved to a `Map`.
 */
function budgetedCollections(list: Array<Partial<Collection>>): Collection[] {
	return list.map((collection) => {
		const { parentId } = collection;
		return Object.defineProperty({ ...collection }, "parentId", {
			enumerable: true,
			get() {
				if (++lookups > LOOKUP_BUDGET) {
					throw new Error(
						`more than ${LOOKUP_BUDGET} parentId reads - the collection chain walk is not terminating`
					);
				}
				return parentId;
			},
		});
	}) as Collection[];
}

const v = (value: string) => ({ value, enabled: true });

beforeEach(() => {
	globals.variables = {};
	collections = [];
	environments.length = 0;
	session.activeEnvironmentId = null;
	lookups = 0;
});

describe("collection chain with a cyclic parentId", () => {
	it("terminates on a two-collection cycle and still resolves leaf-over-root", () => {
		// `child` and `parent` point at each other. Root-first order still puts
		// the starting collection last, so its value is the one that wins.
		collections = budgetedCollections([
			{ id: "child", name: "Child", parentId: "parent", variables: { host: v("child") } },
			{ id: "parent", name: "Parent", parentId: "child", variables: { host: v("parent") } },
		]);

		const { result } = renderHook(() => useVariableResolver({ collectionId: "child" }));

		expect(result.current.getVariable("host")?.value).toBe("child");
		// Both definitions are still reported, so the walk visited each once
		// rather than stopping at the first repeat of the *starting* id.
		expect(result.current.getVariableOrigins("host").map((o) => o.sourceName)).toEqual([
			"Parent",
			"Child",
		]);
	});

	it("terminates on a collection that is its own parent", () => {
		collections = budgetedCollections([
			{ id: "self", name: "Self", parentId: "self", variables: { host: v("self") } },
		]);

		const { result } = renderHook(() => useVariableResolver({ collectionId: "self" }));

		expect(result.current.getVariable("host")?.value).toBe("self");
		expect(result.current.getVariableOrigins("host")).toHaveLength(1);
	});

	it("still walks a whole acyclic chain root-first", () => {
		// The guard must not truncate a legitimate chain - a `seen` set that
		// also deduplicated would break override order rather than a cycle.
		collections = budgetedCollections([
			{ id: "leaf", name: "Leaf", parentId: "mid", variables: { host: v("leaf") } },
			{ id: "mid", name: "Mid", parentId: "root", variables: { host: v("mid") } },
			{ id: "root", name: "Root", variables: { host: v("root") } },
		]);

		const { result } = renderHook(() => useVariableResolver({ collectionId: "leaf" }));

		expect(result.current.getVariable("host")?.value).toBe("leaf");
		expect(result.current.getVariableOrigins("host").map((o) => o.sourceName)).toEqual([
			"Root",
			"Mid",
			"Leaf",
		]);
	});

	it("has a budget the correct walk stays well under", () => {
		// Guards the guard: a budget the honest path could trip would make the
		// cycle tests pass for the wrong reason.
		collections = budgetedCollections([
			{ id: "leaf", name: "Leaf", parentId: "root", variables: {} },
			{ id: "root", name: "Root", variables: {} },
		]);

		renderHook(() => useVariableResolver({ collectionId: "leaf" }));

		expect(lookups).toBeLessThanOrEqual(LOOKUP_BUDGET);
		expect(lookups).toBeGreaterThan(0);
	});
});
