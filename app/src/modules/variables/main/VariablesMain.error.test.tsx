/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A failed fetch must not be reported as a deleted collection or environment.
 *
 * Both queries here are destructured as `{ data = [] }` and nothing sets
 * `throwOnError`, so a query that settles as an error resolves to `[]`, the
 * lookup finds nothing, and the pane announces "Collection not found" - a
 * claim that the user's data is gone, for what is only a failed request.
 *
 * The two queries are independent, so each branch reads its own `isError`.
 * The last case here exists solely to hold that line: collections failing
 * while environments are fine must not put an error pane on the environment
 * branch.
 *
 * Each case asserts both halves - the right pane present *and* the wrong one
 * absent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import VariablesMain from "./VariablesMain";

const refetchCollections = vi.fn();
const refetchEnvironments = vi.fn();

type QueryState = {
	data: unknown[];
	isLoading: boolean;
	isError: boolean;
	error: Error | null;
	refetch: () => void;
};

const state = {
	collections: {} as QueryState,
	environments: {} as QueryState,
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

// The editor itself is not under test; a marker is enough to tell "real
// content rendered" from "an error pane replaced it".
vi.mock("./VariableTableEditor", () => ({
	default: ({ config }: { config: { type: string } }) => (
		<div data-testid="editor">editor:{config.type}</div>
	),
}));

function ok(data: unknown[], refetch: () => void): QueryState {
	return { data, isLoading: false, isError: false, error: null, refetch };
}

function failed(refetch: () => void, data: unknown[] = []): QueryState {
	return { data, isLoading: false, isError: true, error: new Error("Failed to fetch"), refetch };
}

beforeEach(() => {
	refetchCollections.mockReset();
	refetchEnvironments.mockReset();
	state.collections = ok([], refetchCollections);
	state.environments = ok([], refetchEnvironments);
	state.selectedCategory = null;
});

describe("VariablesMain - collection branch when its query fails", () => {
	beforeEach(() => {
		state.selectedCategory = { type: "collection", collectionId: "c1" };
	});

	it("says the load failed instead of that the collection is gone", () => {
		state.collections = failed(refetchCollections);
		render(<VariablesMain />);

		expect(screen.getByText(/couldn't load the collection/i)).toBeInTheDocument();
		expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
		expect(screen.queryByText(/collection not found/i)).not.toBeInTheDocument();
	});

	it("offers a way out, and retrying refetches the collections query", () => {
		state.collections = failed(refetchCollections);
		render(<VariablesMain />);

		screen.getByRole("button", { name: /try again/i }).click();
		expect(refetchCollections).toHaveBeenCalled();
		expect(refetchEnvironments).not.toHaveBeenCalled();
	});

	it("keeps the editor when a background refetch fails but the collection is cached", () => {
		state.collections = failed(refetchCollections, [{ id: "c1", name: "demo", variables: {} }]);
		render(<VariablesMain />);

		expect(screen.getByText("editor:collection")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("still says not found when the query settled cleanly without it", () => {
		render(<VariablesMain />);

		expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});
});

describe("VariablesMain - environment branch when its query fails", () => {
	beforeEach(() => {
		state.selectedCategory = { type: "environment", environmentId: "e1" };
	});

	it("says the load failed instead of that the environment is gone", () => {
		state.environments = failed(refetchEnvironments);
		render(<VariablesMain />);

		expect(screen.getByText(/couldn't load the environment/i)).toBeInTheDocument();
		expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
		expect(screen.queryByText(/environment not found/i)).not.toBeInTheDocument();
	});

	it("offers a way out, and retrying refetches the environments query", () => {
		state.environments = failed(refetchEnvironments);
		render(<VariablesMain />);

		screen.getByRole("button", { name: /try again/i }).click();
		expect(refetchEnvironments).toHaveBeenCalled();
		expect(refetchCollections).not.toHaveBeenCalled();
	});

	it("keeps the editor when a background refetch fails but the environment is cached", () => {
		state.environments = failed(refetchEnvironments, [
			{ id: "e1", name: "staging", variables: {} },
		]);
		render(<VariablesMain />);

		expect(screen.getByText("editor:environment")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("still says not found when the query settled cleanly without it", () => {
		render(<VariablesMain />);

		expect(screen.getByText(/environment not found/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});
});

describe("VariablesMain - each branch reads its own query", () => {
	it("does not blame the environment for a collections failure", () => {
		// Collections errored; environments settled cleanly without e1. The
		// truthful answer for the environment branch is still "not found".
		state.selectedCategory = { type: "environment", environmentId: "e1" };
		state.collections = failed(refetchCollections);
		state.environments = ok([], refetchEnvironments);
		render(<VariablesMain />);

		expect(screen.getByText(/environment not found/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("does not blame the collection for an environments failure", () => {
		state.selectedCategory = { type: "collection", collectionId: "c1" };
		state.environments = failed(refetchEnvironments);
		state.collections = ok([], refetchCollections);
		render(<VariablesMain />);

		expect(screen.getByText(/collection not found/i)).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});
});
