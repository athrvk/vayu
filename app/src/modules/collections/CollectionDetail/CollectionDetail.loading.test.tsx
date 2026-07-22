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
 * "Collection not found" must mean not found.
 *
 * `useCollectionsQuery` defaults to `[]`, so a collection tab restored from a
 * previous session found nothing while its query was still in flight, and the
 * screen said the collection was missing. That is the same defect already
 * fixed in the variables editor - an error state claiming the user's data is
 * gone, when the truthful answer is "not loaded yet".
 *
 * Each case asserts both halves - the loading pane present *and* the missing
 * copy absent - since asserting only the first would pass if both rendered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionDetail from "./index";

const state = {
	collections: { data: [] as unknown[], isLoading: false },
};

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => state.collections,
	useRequestsQuery: () => ({ data: [], isLoading: false }),
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

beforeEach(() => {
	state.collections = { data: [], isLoading: false };
});

describe("CollectionDetail while its query is in flight", () => {
	it("shows a loading pane, not a missing collection", () => {
		state.collections = { data: [], isLoading: true };
		render(<CollectionDetail />);
		expect(screen.getByRole("status", { name: /loading collection/i })).toBeInTheDocument();
		expect(screen.queryByText(/not found/i)).toBeNull();
	});

	it("reports the collection missing once the query has settled without it", () => {
		state.collections = { data: [], isLoading: false };
		render(<CollectionDetail />);
		expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
		expect(screen.queryByRole("status", { name: /loading/i })).toBeNull();
	});

	it("renders the collection when it is there", () => {
		state.collections = { data: [{ id: "c1", name: "demo", variables: {} }], isLoading: false };
		render(<CollectionDetail />);
		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.queryByText(/not found/i)).toBeNull();
	});
});
