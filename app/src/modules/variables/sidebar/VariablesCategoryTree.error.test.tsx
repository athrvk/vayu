/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A failed load is not an empty scope list.
 *
 * Both queries here are destructured with `= []` defaults and nothing sets
 * `throwOnError`, so a query that settles as an error resolves to `[]` and the
 * section says "No collections" / "No environments" — a claim about the user's
 * data, made when no data arrived.
 *
 * The two sections read two different queries, so they are tested as two
 * independent answers: one failing must not silence the other. Each case
 * asserts both halves, since a branch that fails to exclude the empty case
 * would render the error *and* the empty row together.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";

const refetchCollections = vi.fn();
const refetchEnvironments = vi.fn();

type Section = {
	data: unknown[];
	isLoading: boolean;
	isError: boolean;
	refetch: () => void;
};

const queryState: { collections: Section; environments: Section } = {
	collections: { data: [], isLoading: false, isError: false, refetch: refetchCollections },
	environments: { data: [], isLoading: false, isError: false, refetch: refetchEnvironments },
};

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => queryState.collections,
	useEnvironmentsQuery: () => queryState.environments,
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// TooltipProvider mirrors main.tsx: the tree contains a TooltipIconButton.
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	refetchCollections.mockReset();
	refetchEnvironments.mockReset();
	queryState.collections = {
		data: [],
		isLoading: false,
		isError: false,
		refetch: refetchCollections,
	};
	queryState.environments = {
		data: [],
		isLoading: false,
		isError: false,
		refetch: refetchEnvironments,
	};
});

describe("VariablesCategoryTree when a scope query fails", () => {
	it("says each load failed instead of that there is nothing", () => {
		queryState.collections.isError = true;
		queryState.environments.isError = true;
		renderTree();

		expect(screen.getByText("Couldn't load collections")).toBeInTheDocument();
		expect(screen.getByText("Couldn't load environments")).toBeInTheDocument();
		expect(screen.queryByText("No collections")).not.toBeInTheDocument();
		expect(screen.queryByText("No environments")).not.toBeInTheDocument();
	});

	it("keeps the sections independent — one failing says nothing about the other", () => {
		queryState.collections.isError = true;
		renderTree();

		expect(screen.getByText("Couldn't load collections")).toBeInTheDocument();
		expect(screen.queryByText("No collections")).not.toBeInTheDocument();
		// Environments settled fine and genuinely has nothing.
		expect(screen.getByText("No environments")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load environments")).not.toBeInTheDocument();
	});

	it("retries the section's own query", () => {
		queryState.collections.isError = true;
		queryState.environments.isError = true;
		renderTree();

		const retries = screen.getAllByRole("button", { name: /try again/i });
		expect(retries).toHaveLength(2);
		retries.forEach((r) => r.click());
		expect(refetchCollections).toHaveBeenCalled();
		expect(refetchEnvironments).toHaveBeenCalled();
	});

	it("keeps a working list when a background refetch fails", () => {
		// TanStack keeps the last good data through a failed refetch.
		queryState.collections = {
			data: [{ id: "c1", name: "demo collection", order: 0 }],
			isLoading: false,
			isError: true,
			refetch: refetchCollections,
		};
		queryState.environments = {
			data: [{ id: "e1", name: "demo env", variables: {} }],
			isLoading: false,
			isError: true,
			refetch: refetchEnvironments,
		};
		renderTree();

		expect(screen.getByText("demo collection")).toBeInTheDocument();
		expect(screen.getByText("demo env")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("still shows the empty rows when the queries simply returned nothing", () => {
		renderTree();

		expect(screen.getByText("No collections")).toBeInTheDocument();
		expect(screen.getByText("No environments")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("shows a dash rather than a count it does not have", () => {
		// A literal 0 beside "Couldn't load collections" asserts that the user
		// has none — the same lie the body was just fixed to stop telling. The
		// environments section is given real data so a stray "0" could only come
		// from the failed one.
		queryState.collections = {
			data: [],
			isLoading: false,
			isError: true,
			refetch: refetchCollections,
		};
		queryState.environments = {
			data: [{ id: "e1", name: "staging", variables: {} }],
			isLoading: false,
			isError: false,
			refetch: refetchEnvironments,
		};
		renderTree();

		expect(screen.getByText("Couldn't load collections")).toBeInTheDocument();
		expect(screen.queryByText("0")).toBeNull();
		expect(screen.getByText("—")).toBeInTheDocument();
	});
});
