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
 * Two sub-collections called "v1" under different parents are told apart by the
 * path in front of the name (#3495): a muted prefix that gives way first, and a
 * row whose accessible name is the whole path. jsdom has no layout, so what
 * "gives way first" means is held as the rendered classes.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Collection } from "@/types";

function collection(id: string, name: string, parentId?: string): Collection {
	return {
		id,
		name,
		parentId,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const settled = { isLoading: false, isError: false, refetch: vi.fn() };
let collections: Collection[] = [];

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...settled, data: collections }),
	useEnvironmentsQuery: () => ({ ...settled, data: [] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderTree() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return screen.getByRole("tree", { name: "Variable scopes" });
}

const TWO_V1S = [
	collection("pay", "Payments API"),
	collection("pay-v1", "v1", "pay"),
	collection("crm", "CRM"),
	collection("crm-v1", "v1", "crm"),
];

describe("a sub-collection shows where it sits", () => {
	it("names two same-named sub-collections by their whole path", () => {
		collections = TWO_V1S;
		const tree = renderTree();

		expect(
			within(tree).getByRole("treeitem", { name: "Payments API / v1" })
		).toBeInTheDocument();
		expect(within(tree).getByRole("treeitem", { name: "CRM / v1" })).toBeInTheDocument();
	});

	it("names a deeper sub-collection by every ancestor, root first", () => {
		collections = [
			collection("a", "A"),
			collection("b", "B", "a"),
			collection("leaf", "v1", "b"),
		];
		const tree = renderTree();

		expect(within(tree).getByRole("treeitem", { name: "A / B / v1" })).toBeInTheDocument();
	});

	it("gives a root collection no prefix and its bare name", () => {
		collections = TWO_V1S;
		const tree = renderTree();
		const root = within(tree).getByRole("treeitem", { name: "Payments API" });

		expect(root.getAttribute("aria-labelledby")).not.toMatch(/ /);
		expect(root.textContent).toBe("Payments API");
	});

	it("keeps typeahead on the name alone", () => {
		collections = TWO_V1S;
		const tree = renderTree();
		const row = within(tree).getByRole("treeitem", { name: "CRM / v1" });

		expect(row.getAttribute("data-tree-label")).toBe("v1");
	});

	it("draws the ancestors muted and cuttable, and the name with a floor", () => {
		collections = TWO_V1S;
		const tree = renderTree();
		const row = within(tree).getByRole("treeitem", { name: "Payments API / v1" });
		const prefix = within(row).getByText("Payments API /");
		const name = within(row).getByText("v1");

		expect(prefix.className).toContain("text-muted-foreground");
		expect(prefix.className).toContain("min-w-0");
		expect(prefix.className).toContain("max-w-[50%]");
		expect(prefix.className).toContain("truncate");
		expect(prefix.className).not.toContain("shrink-0");
		expect(name.className).toContain("min-w-[12ch]");
		expect(name.className).not.toContain("text-muted-foreground");
	});
});
