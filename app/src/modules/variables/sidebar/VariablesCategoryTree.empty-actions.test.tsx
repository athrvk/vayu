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
 * The two empty groups offer a way out (issue #1693).
 *
 * Both were a hand-rolled italic line - not even `EmptyState` - saying "No
 * environments" / "No collections" and nothing else, in a sidebar whose only
 * create affordance is a tooltip icon button in the group header. The notes
 * are `EmptyState` now, and each carries the same handler as that header
 * button: the environments one opens the inline create row, the collections
 * one reveals the Collections drawer, since a collection is not created here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import VariablesCategoryTree from "./VariablesCategoryTree";

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: [], isLoading: false }),
	useEnvironmentsQuery: () => ({ data: [], isLoading: false }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	useLayoutStore.setState({ drawerView: "history", drawerOpen: false });
});

describe("the variables sidebar's empty groups", () => {
	it("opens the inline create row from the empty environments note", () => {
		renderTree();
		expect(screen.getByText("No environments")).toBeInTheDocument();
		// Two by design: the group header's icon button and the note's link,
		// both on the same handler.
		const add = screen.getAllByRole("button", { name: "Add environment" });
		expect(add).toHaveLength(2);
		fireEvent.click(add[1]);
		expect(screen.getByPlaceholderText(/environment name/i)).toBeInTheDocument();
	});

	it("sends the empty collections note to the Collections drawer", () => {
		renderTree();
		expect(screen.getByText("No collections")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Browse collections" }));
		expect(useLayoutStore.getState().drawerView).toBe("collections");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
