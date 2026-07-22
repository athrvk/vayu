/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An in-flight query must not render as an empty tree.
 *
 * This view used to take both lists as props from the Drawer, which read them
 * with `= []` defaults and dropped `isLoading`. While the queries were still
 * running the user was told "No environments" and "No collections" - a factual
 * claim about their data, made before any data had arrived.
 *
 * The empty state and the loading state are different answers to different
 * questions, so each case below asserts both that the placeholder is shown and
 * that the empty-state copy is absent. Asserting only the former would pass
 * even if both rendered at once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";

const queryState = {
	collections: { data: [] as unknown[], isLoading: false },
	environments: { data: [] as unknown[], isLoading: false },
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
	// TooltipProvider mirrors main.tsx: the tree contains a TooltipIconButton
	// (Add environment), and Radix Tooltip throws without a provider ancestor.
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

describe("VariablesCategoryTree loading state", () => {
	beforeEach(() => {
		queryState.collections = { data: [], isLoading: false };
		queryState.environments = { data: [], isLoading: false };
	});

	it("shows placeholders instead of an empty state while both queries load", () => {
		queryState.collections = { data: [], isLoading: true };
		queryState.environments = { data: [], isLoading: true };
		renderTree();

		expect(screen.getAllByRole("status", { name: "Loading" }).length).toBeGreaterThan(0);
		expect(screen.queryByText("No environments")).not.toBeInTheDocument();
		expect(screen.queryByText("No collections")).not.toBeInTheDocument();
	});

	it("reports the empty state once the queries have settled with nothing", () => {
		renderTree();

		expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
		expect(screen.getByText("No environments")).toBeInTheDocument();
		expect(screen.getByText("No collections")).toBeInTheDocument();
	});

	it("resolves each section independently", () => {
		// Environments still loading, collections done and genuinely empty.
		queryState.environments = { data: [], isLoading: true };
		renderTree();

		expect(screen.queryByText("No environments")).not.toBeInTheDocument();
		expect(screen.getByText("No collections")).toBeInTheDocument();
	});

	it("withholds the section count until it is known", () => {
		queryState.environments = { data: [], isLoading: true };
		renderTree();

		// A count of 0 is a claim about the data; an unloaded list has no count.
		expect(screen.getByText("-")).toBeInTheDocument();
	});
});
