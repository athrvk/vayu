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
 * A failed fetch must not be reported as a deleted collection.
 *
 * `useCollectionsQuery` is destructured as `{ data: collections = [] }` and
 * nothing sets `throwOnError`, so a query that settles as an error never
 * reaches the ErrorBoundary - it resolves to `[]`, the pane finds no
 * collection, and it renders "Collection not found". That copy is a claim
 * about the user's data: it says the thing they opened is gone. The truth is
 * that the request failed and it may well still be there.
 *
 * Loading, missing and failed are three answers. The loading leg is guarded in
 * CollectionDetail.loading.test.tsx; this file guards the third.
 *
 * Each case asserts both halves - the right pane present *and* the wrong one
 * absent - since asserting only the first would pass if both rendered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionDetail from "./index";

const refetch = vi.fn();
const state = {
	collections: {
		data: [] as unknown[],
		isLoading: false,
		isError: false,
		error: null as Error | null,
		refetch,
	},
};

/**
 * The snippets list under a script editor reads the engine's completion table
 * (#1223). Its own behaviour is `ScriptSnippets.test.tsx`; here it only needs
 * to not reach for a QueryClient this suite does not set up.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => state.collections,
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	// The shell counts the whole subtree for its header (issue #723); an empty
	// map is "no requests anywhere", which is what these cases are about.
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
}));

vi.mock("@/stores", () => ({
	useTabsStore: () => ({
		openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
		activeTabId: "t1",
	}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

vi.mock("./AuthTab", () => ({ default: () => null }));
vi.mock("./InfoTab", () => ({ default: () => null }));
vi.mock("./ScriptTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));
// The header's mock-server control reaches the engine and the toast store;
// this file is about the tab shell, and its own suite covers the control.
vi.mock("./MockServerControl", () => ({ default: () => null }));

beforeEach(() => {
	refetch.mockReset();
	state.collections = { data: [], isLoading: false, isError: false, error: null, refetch };
});

describe("CollectionDetail when the collections query fails", () => {
	it("says the load failed instead of that the collection is gone", () => {
		state.collections = {
			data: [],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		render(<CollectionDetail />);

		expect(screen.getByText(/couldn't load the collection/i)).toBeInTheDocument();
		expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
		// The half that matters: the app stops claiming the entity was deleted.
		expect(screen.queryByText(/collection not found/i)).not.toBeInTheDocument();
	});

	it("offers a way out, and retrying refetches", () => {
		state.collections = {
			data: [],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		render(<CollectionDetail />);

		screen.getByRole("button", { name: /try again/i }).click();
		expect(refetch).toHaveBeenCalled();
	});

	it("keeps showing the collection when a background refetch fails", () => {
		// TanStack keeps the last good data through a failed refetch. Replacing
		// a working pane with an error would take away more than it tells.
		state.collections = {
			data: [{ id: "c1", name: "demo", variables: {} }],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		render(<CollectionDetail />);

		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("still says not found when the query settled cleanly without it", () => {
		render(<CollectionDetail />);

		expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});
});
