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
 * How much is in the collection, counted the way the tree beside it counts.
 *
 * Direct children only: a subtree total would disagree with the rows the user
 * can see under the folder. Mutation-check: count descendants instead of
 * children and the nested case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionContentsSection } from "./CollectionContentsSection";
import type { Collection, Request } from "@/types";

let collections: Collection[] = [];
let requests: Request[] = [];
let loading = false;

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections, isLoading: loading }),
	useRequestsQuery: (collectionId: string | null) => ({
		data: requests.filter((r) => r.collectionId === collectionId),
		isLoading: loading,
	}),
}));

const TAB = { id: "t1", type: "collection", entityId: "col_1" } as const;

const collection = (id: string, parentId?: string): Collection => ({
	id,
	name: id,
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "",
	updatedAt: "",
	...(parentId ? { parentId } : {}),
});

const request = (id: string, collectionId: string) =>
	({ id, collectionId, name: id, method: "GET", url: "" }) as unknown as Request;

beforeEach(() => {
	collections = [];
	requests = [];
	loading = false;
});

describe("CollectionContentsSection", () => {
	it("counts the requests and folders directly inside it", () => {
		collections = [collection("col_1"), collection("col_child", "col_1")];
		requests = [request("r1", "col_1"), request("r2", "col_1")];
		render(<CollectionContentsSection tab={TAB} />);

		expect(screen.getByText(/2 requests/)).toBeInTheDocument();
		expect(screen.getByText(/1 sub-collection$/)).toBeInTheDocument();
	});

	it("does not count a grandchild folder as a child", () => {
		collections = [
			collection("col_1"),
			collection("col_child", "col_1"),
			collection("col_grandchild", "col_child"),
		];
		render(<CollectionContentsSection tab={TAB} />);

		expect(screen.getByText(/1 sub-collection$/)).toBeInTheDocument();
	});

	it("says zero rather than nothing when the collection is empty", () => {
		collections = [collection("col_1")];
		render(<CollectionContentsSection tab={TAB} />);

		expect(screen.getByText(/0 requests/)).toBeInTheDocument();
		expect(screen.getByText(/0 sub-collections$/)).toBeInTheDocument();
	});

	it("says the collection is gone rather than counting it as empty", () => {
		collections = [collection("col_other")];
		render(<CollectionContentsSection tab={TAB} />);

		expect(screen.getByText("This collection is no longer available")).toBeInTheDocument();
	});

	it("waits rather than declaring a collection missing while the lists are in flight", () => {
		loading = true;
		render(<CollectionContentsSection tab={TAB} />);

		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});
