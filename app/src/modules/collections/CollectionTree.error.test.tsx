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
 * A failed fetch must not look like an empty workspace.
 *
 * `useCollectionsQuery` is destructured as `{ data: collections = [] }`, and
 * nothing sets `throwOnError`, so a query that settles as an error never
 * reaches the ErrorBoundary - it just resolves to `[]`. The tree then rendered
 * "No collections yet" with an "Add your first collection" button, which is
 * worse than merely wrong: it invites a user whose collections exist but could
 * not be loaded to create a duplicate.
 *
 * Loading, empty and failed are three different answers and each gets its own
 * render. This file guards the third.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import CollectionTree from "./CollectionTree";

const refetch = vi.fn();
const queryState = {
	collections: {
		data: [] as unknown[],
		isLoading: false,
		isError: false,
		error: null as Error | null,
		refetch,
	},
};

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => queryState.collections,
	// Destructured as { requestsByCollection }, a Map keyed by collection id.
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map() }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	refetch.mockReset();
	queryState.collections = {
		data: [],
		isLoading: false,
		isError: false,
		error: null,
		refetch,
	};
});

describe("CollectionTree when the collections query fails", () => {
	it("says the load failed instead of that there is nothing", () => {
		queryState.collections = {
			data: [],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		renderTree();

		expect(screen.getByText(/couldn't load collections/i)).toBeInTheDocument();
		// The dangerous half: a create CTA here invites a duplicate.
		expect(screen.queryByText("No collections yet")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /add your first collection/i })
		).not.toBeInTheDocument();
	});

	it("offers a way out, and retrying refetches", async () => {
		queryState.collections = {
			data: [],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		renderTree();

		const retry = screen.getByRole("button", { name: /try again/i });
		retry.click();
		expect(refetch).toHaveBeenCalled();
	});

	it("keeps a working tree when a background refetch fails", () => {
		// TanStack keeps the last good data through a failed refetch. Replacing
		// a populated tree with an error pane would take away more than it says.
		queryState.collections = {
			data: [{ id: "c1", name: "demo", order: 0 }],
			isLoading: false,
			isError: true,
			error: new Error("Failed to fetch"),
			refetch,
		};
		renderTree();

		expect(screen.getByText("demo")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});

	it("still shows the empty state when the query simply returned nothing", () => {
		renderTree();
		expect(screen.getByText("No collections yet")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
	});
});
