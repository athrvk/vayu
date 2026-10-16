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
 * The count beside a folder's name (#2251).
 *
 * A root answers "how many requests are in here", the figure the import preview
 * gave ("60 requests"); a 60-request import into four folders used to read (4).
 * A nested folder keeps its direct children, requests and folders together,
 * which is also what its group announces as `aria-setsize`.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import CollectionItem from "./CollectionItem";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Collection, Request } from "@/types";

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

function folder(id: string, parentId?: string): Collection {
	return {
		id,
		name: id,
		parentId,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

/** Only the count reads these, so the fields the row never touches stay off. */
function requestsFor(collectionId: string, count: number): Request[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${collectionId}_req_${i}`,
		collectionId,
	})) as Request[];
}

/** The row's own count, read from the first treeitem (the one rendered). */
function renderCount(
	collection: Collection,
	depth: number,
	allCollections: Collection[],
	requestCounts: Record<string, number>
): string | null | undefined {
	const { container } = render(
		withCollectionTreeContext(
			<CollectionItem collection={collection} depth={depth} posInSet={1} setSize={1} />,
			{
				allCollections,
				getRequestsByCollection: (id) => requestsFor(id, requestCounts[id] ?? 0),
			}
		)
	);
	return container.querySelector('[role="treeitem"] [data-tree-activate] > span:last-child')
		?.textContent;
}

describe("a root folder's count", () => {
	const root = folder("root");
	const children = ["a", "b", "c", "d"].map((id) => folder(id, "root"));

	it("is the requests in its whole subtree, not the folders it holds", () => {
		const counts = { a: 15, b: 15, c: 15, d: 15 };
		expect(renderCount(root, 0, [root, ...children], counts)).toBe("(60)");
	});

	it("includes a request in a grandchild folder", () => {
		const grandchild = folder("a1", "a");
		const counts = { root: 1, a: 2, a1: 4 };
		expect(renderCount(root, 0, [root, ...children, grandchild], counts)).toBe("(7)");
	});

	it("terminates on a parent cycle and counts each folder once", () => {
		const x = folder("x", "y");
		const y = folder("y", "x");
		expect(renderCount(x, 0, [x, y], { x: 1, y: 2 })).toBe("(3)");
	});
});

describe("a nested folder's count", () => {
	it("stays its direct children: requests plus child folders", () => {
		const root = folder("root");
		const mid = folder("mid", "root");
		const leafA = folder("leafA", "mid");
		const leafB = folder("leafB", "mid");
		const counts = { mid: 3, leafA: 10, leafB: 10 };

		expect(renderCount(mid, 1, [root, mid, leafA, leafB], counts)).toBe("(5)");
	});
});
