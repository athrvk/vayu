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
 * Which row outlives a delete (#1218).
 *
 * `CollectionTree.a11y.test.tsx` proves the rule reaches the user through the
 * real tree, on the one shape that tree renders. This covers the shapes it does
 * not: a folder deleted with its subtree open, a delete at the root, the last
 * row of all. The markup here is the tree's own - a row and its children are
 * *siblings* inside a wrapper, not nested - because `rowAfterRemoving` reads
 * `aria-level` off the DOM and a flat fixture would not exercise the case that
 * matters, where the rows between a folder and its next sibling are the ones
 * about to die with it.
 */

import { describe, it, expect } from "vitest";
import { rowAfterRemoving, treeRows } from "./tree-focus";

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

const rowFor = (tree: HTMLElement, id: string) =>
	tree.querySelector<HTMLElement>(`[data-id="${id}"]`)!;

/** The id of the row focus should land on, or null. */
function successorOf(tree: HTMLElement, id: string): string | null {
	return rowAfterRemoving(tree, rowFor(tree, id))?.dataset.id ?? null;
}

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
