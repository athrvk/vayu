/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Not found" must mean not found.
 *
 * Both queries here default to `[]`, so a category restored from a previous
 * session resolved to `undefined` while its query was still in flight, and the
 * screen announced "Collection not found" — an error, for something that had
 * simply not arrived yet. The same shape as the sidebar's "No environments"
 * bug, but worse: an empty state is merely wrong, an error state tells the user
 * their data is gone.
 *
 * Each case asserts both halves — that the loading pane is shown *and* that the
 * error copy is absent — since asserting only the first would pass even if both
 * rendered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import VariablesMain from "./VariablesMain";

const state = {
	collections: { data: [] as unknown[], isLoading: false },
	environments: { data: [] as unknown[], isLoading: false },
	selectedCategory: null as unknown,
};

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => state.collections,
	useEnvironmentsQuery: () => state.environments,
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn() }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({
		selectedCategory: state.selectedCategory,
		setSelectedCategory: vi.fn(),
	}),
}));

describe("VariablesMain — loading vs not found", () => {
	beforeEach(() => {
		state.collections = { data: [], isLoading: false };
		state.environments = { data: [], isLoading: false };
		state.selectedCategory = null;
	});

	it("shows a loading pane, not an error, while the collection query is in flight", () => {
		state.selectedCategory = { type: "collection", collectionId: "c1" };
		state.collections = { data: [], isLoading: true };
		render(<VariablesMain />);
		expect(screen.getByRole("status", { name: "Loading collection" })).toBeInTheDocument();
		expect(screen.queryByText(/Collection not found/i)).not.toBeInTheDocument();
	});

	it("shows a loading pane, not an error, while the environment query is in flight", () => {
		state.selectedCategory = { type: "environment", environmentId: "e1" };
		state.environments = { data: [], isLoading: true };
		render(<VariablesMain />);
		expect(screen.getByRole("status", { name: "Loading environment" })).toBeInTheDocument();
		expect(screen.queryByText(/Environment not found/i)).not.toBeInTheDocument();
	});

	it("does say not found once the query has settled without it", () => {
		state.selectedCategory = { type: "collection", collectionId: "missing" };
		state.collections = { data: [], isLoading: false };
		render(<VariablesMain />);
		expect(screen.getByText(/Collection not found/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: "Loading collection" })
		).not.toBeInTheDocument();
	});
});
