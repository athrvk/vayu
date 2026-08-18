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
 * What "N requests" names on the collection screen (issue #723).
 *
 * An OpenAPI import files its requests under one sub-collection per tag, so a
 * spec-bound root owns none directly. The header counted only those, and read
 * "GitHub v3 REST API - 0 requests" beside a mock toggle serving the whole
 * subtree, a Run dialog running it, and a Spec tab counting it. One screen, two
 * meanings for one word, and the smaller one on the line a reader sees first.
 *
 * These pin the subtree meaning in both places that state it, so the header and
 * the Info tab cannot drift apart from each other or from the surfaces around
 * them. The mutation each guards against is the narrower read coming back: swap
 * the subtree count for the root's own requests and the first two go red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionDetail from "./index";

/** `spec-root` owns nothing directly; its two tag folders hold four requests. */
const collections = [
	{ id: "spec-root", name: "GitHub v3 REST API", variables: {} },
	{ id: "tag-users", name: "users", parentId: "spec-root", variables: {} },
	{ id: "tag-repos", name: "repos", parentId: "spec-root", variables: {} },
	{ id: "elsewhere", name: "unrelated", variables: {} },
];

const requestsByCollection = new Map<string, unknown[]>([
	["spec-root", []],
	["tag-users", [{ id: "r1" }, { id: "r2" }]],
	["tag-repos", [{ id: "r3" }, { id: "r4" }]],
	// Outside the subtree. Present so a count that ignores the walk and sums
	// every cached collection is red too, not just one that ignores children.
	["elsewhere", [{ id: "r5" }, { id: "r6" }, { id: "r7" }]],
]);

const seenIds: string[][] = [];

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: collections, isLoading: false, isError: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	useMultipleCollectionRequests: (ids: string[]) => {
		seenIds.push(ids);
		return {
			requestsByCollection: new Map(
				ids.map((id) => [id, requestsByCollection.get(id) ?? []])
			),
			isLoading: false,
		};
	},
}));

vi.mock("@/stores", () => ({
	useTabsStore: () => ({
		openTabs: [{ id: "t1", type: "collection", entityId: "spec-root" }],
		activeTabId: "t1",
	}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

// Stubbed to read back the prop the shell hands it: the count is computed once
// in the shell and passed down, so what this file can prove about the Info tab
// is that it is given the subtree number. InfoTab's own suite covers the Stat.
vi.mock("./InfoTab", () => ({
	default: ({ requestCount }: { requestCount: number }) => (
		<div data-testid="info-request-count">{requestCount}</div>
	),
}));

vi.mock("./AuthTab", () => ({ default: () => null }));
vi.mock("./ScriptTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));
// Reaches the engine and the toast store; its own suite covers it.
vi.mock("./MockServerControl", () => ({ default: () => null }));

beforeEach(() => {
	seenIds.length = 0;
});

describe("the request count on a spec-bound root", () => {
	it("counts the subtree in the header, not the requests the root owns", () => {
		render(<CollectionDetail />);
		expect(screen.getByText(/- 4 requests/)).toBeTruthy();
		expect(screen.queryByText(/- 0 requests/)).toBeNull();
	});

	it("hands the Info tab the same number the header states", () => {
		// Two surfaces, one count, computed once in the shell: the Info tab used
		// to be handed the root's own requests, so agreeing here is what stops
		// the screen contradicting itself again.
		render(<CollectionDetail />);
		expect(screen.getByTestId("info-request-count").textContent).toBe("4");
	});

	it("walks the subtree rather than every collection the cache holds", () => {
		render(<CollectionDetail />);
		expect([...seenIds[seenIds.length - 1]].sort()).toEqual([
			"spec-root",
			"tag-repos",
			"tag-users",
		]);
	});
});
