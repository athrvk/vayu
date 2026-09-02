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
 * What owns a row (#1237), and which row outlives a delete (#1218) - the two
 * questions the tree answers off `aria-level`, in the one file that answers
 * them.
 *
 * `CollectionTree.a11y.test.tsx` proves both rules reach the user through the
 * real tree, on the one shape that tree renders. This covers the shapes it does
 * not: a group three rows wide, a folder deleted with its subtree open, a
 * delete at the root, the last row of all. The markup here is the tree's own -
 * a row and its children are *siblings* inside a wrapper, not nested - because
 * a flat fixture would not exercise the case that matters, where the rows
 * between a folder and its next sibling are the ones about to die with it.
 * `buildFlatTree` is the second shape a consumer actually renders, and the
 * reason neither answer may be read out of the DOM.
 */

import { describe, it, expect } from "vitest";
import { parentRow, rowAfterRemoving, treeRows } from "./tree-focus";

interface Node {
	id: string;
	children?: Node[];
}

/** Builds the tree's shape: `<div><row/><div role=group>…</div></div>` per row. */
function buildTree(nodes: Node[]): HTMLElement {
	const tree = document.createElement("div");
	tree.setAttribute("role", "tree");

	const add = (parent: HTMLElement, list: Node[], level: number) => {
		for (const node of list) {
			const wrapper = document.createElement("div");
			const row = document.createElement("div");
			row.setAttribute("role", "treeitem");
			row.setAttribute("aria-level", String(level));
			row.dataset.id = node.id;
			wrapper.append(row);
			if (node.children?.length) {
				const group = document.createElement("div");
				group.setAttribute("role", "group");
				add(group, node.children, level + 1);
				wrapper.append(group);
			}
			parent.append(wrapper);
		}
	};

	add(tree, nodes, 1);
	return tree;
}

/**
 * The other shape a consumer renders: every row a direct child of the tree, at
 * whatever depth, with `aria-level` carrying the whole hierarchy. The schema
 * explorer flattens its rows this way, so nothing about the DOM says what owns
 * what - which is why parentage is read off the level rather than the nesting.
 */
function buildFlatTree(levels: [string, number][]): HTMLElement {
	const tree = document.createElement("div");
	tree.setAttribute("role", "tree");
	for (const [id, level] of levels) {
		const row = document.createElement("div");
		row.setAttribute("role", "treeitem");
		row.setAttribute("aria-level", String(level));
		row.dataset.id = id;
		tree.append(row);
	}
	return tree;
}

const rowFor = (tree: HTMLElement, id: string) =>
	tree.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

/** The id of the row that owns `id`, or null. */
function parentOf(tree: HTMLElement, id: string): string | null {
	const rows = treeRows(tree);
	return parentRow(rows, rows.indexOf(rowFor(tree, id)))?.dataset.id ?? null;
}

/** The id of the row focus should land on, or null. */
function successorOf(tree: HTMLElement, id: string): string | null {
	return rowAfterRemoving(tree, rowFor(tree, id))?.dataset.id ?? null;
}

describe("parentRow", () => {
	it("takes the owner row from any row in a group, not the group's first", () => {
		const tree = buildTree([{ id: "a", children: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] }]);

		// The DOM walk this replaced answered "a1" for the last two: a group's
		// first row is a sibling of every row after it (#1237).
		expect(parentOf(tree, "a1")).toBe("a");
		expect(parentOf(tree, "a2")).toBe("a");
		expect(parentOf(tree, "a3")).toBe("a");
	});

	it("answers at every depth, and skips a deeper subtree in between", () => {
		const tree = buildTree([
			{
				id: "a",
				children: [{ id: "a1", children: [{ id: "a1x" }, { id: "a1y" }] }, { id: "a2" }],
			},
		]);

		expect(parentOf(tree, "a1y")).toBe("a1");
		// "a2" follows a subtree, so the row above it is a level-3 row it does
		// not belong to.
		expect(parentOf(tree, "a2")).toBe("a");
	});

	it("is null for a root, rather than the root before it", () => {
		const tree = buildTree([{ id: "a", children: [{ id: "a1" }] }, { id: "b" }]);

		expect(parentOf(tree, "a")).toBeNull();
		expect(parentOf(tree, "b")).toBeNull();
	});

	it("is null for an index no row holds", () => {
		const rows = treeRows(buildTree([{ id: "a" }]));

		expect(parentRow(rows, -1)).toBeNull();
		expect(parentRow(rows, rows.length)).toBeNull();
	});

	it("reads the level, not the nesting, so a flattened tree resolves too", () => {
		const tree = buildFlatTree([
			["query", 1],
			["field", 2],
			["arg", 3],
			["mutation", 1],
		]);

		expect(parentOf(tree, "arg")).toBe("field");
		expect(parentOf(tree, "field")).toBe("query");
		expect(parentOf(tree, "mutation")).toBeNull();
	});
});

describe("rowAfterRemoving", () => {
	it("takes the next row in the deleted row's own set", () => {
		const tree = buildTree([{ id: "a" }, { id: "b" }, { id: "c" }]);

		expect(successorOf(tree, "b")).toBe("c");
	});

	it("takes the parent when the deleted row was last in its set", () => {
		const tree = buildTree([{ id: "a", children: [{ id: "a1" }, { id: "a2" }] }, { id: "b" }]);

		// "b" follows "a2" in the document and is not in its set - the row after
		// a last child belongs to an ancestor's set, not to the deleted row's.
		expect(successorOf(tree, "a2")).toBe("a");
	});

	it("skips the deleted folder's own descendants, which go with it", () => {
		const tree = buildTree([
			{ id: "a", children: [{ id: "a1", children: [{ id: "a1x" }] }] },
			{ id: "b" },
		]);

		// The next three rows in document order are all inside "a".
		expect(successorOf(tree, "a")).toBe("b");
	});

	it("skips them from any depth, not just the root", () => {
		const tree = buildTree([
			{
				id: "a",
				children: [{ id: "a1", children: [{ id: "a1x" }, { id: "a1y" }] }, { id: "a2" }],
			},
		]);

		expect(successorOf(tree, "a1")).toBe("a2");
	});

	it("takes the following root when the first root goes", () => {
		const tree = buildTree([{ id: "a" }, { id: "b" }]);

		expect(successorOf(tree, "a")).toBe("b");
	});

	it("takes the row before it when the last root goes", () => {
		const tree = buildTree([{ id: "a", children: [{ id: "a1" }] }, { id: "b" }]);

		// Nothing follows "b" and it has no parent. What is left of the tree is
		// above it, and its last row is the nearest thing to where "b" was.
		expect(successorOf(tree, "b")).toBe("a1");
	});

	it("has nothing to offer when the tree held one row", () => {
		const tree = buildTree([{ id: "a" }]);

		expect(successorOf(tree, "a")).toBeNull();
	});

	it("has nothing to offer for a row the tree does not hold", () => {
		const tree = buildTree([{ id: "a" }]);
		const stranger = buildTree([{ id: "x" }]);

		expect(rowAfterRemoving(tree, rowFor(stranger, "x"))).toBeNull();
	});

	it("reads rows in document order, collapsed subtrees being absent", () => {
		// A collapsed folder renders no group at all, so its children are not in
		// `treeRows` and cannot be chosen - the same list the roving hook walks.
		const tree = buildTree([{ id: "a" }, { id: "b", children: [{ id: "b1" }] }]);

		expect(treeRows(tree).map((r) => r.dataset.id)).toEqual(["a", "b", "b1"]);
		expect(treeRows(buildTree([{ id: "a" }, { id: "b" }])).map((r) => r.dataset.id)).toEqual([
			"a",
			"b",
		]);
	});
});
