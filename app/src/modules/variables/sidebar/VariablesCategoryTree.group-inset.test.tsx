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
 * One level shows one left edge, in the variables sidebar too.
 *
 * A section's rows are indented 50px, past the header's chevron and icon. What
 * stands in for those rows was not: the empty line and the failure line at
 * 12px, the new-environment field at 24px, the loading skeleton at 4px (#1372).
 * Under one expanded header the eye saw up to four left edges, and the section
 * appeared to shift sideways as its query settled.
 *
 * Each case asserts the state's left-edge class *equals the one a real
 * environment row renders*, rather than naming `pl-12.5` again: the value can
 * move, but a placeholder standing where no row would stand is the defect.
 * Reverting any one of the four to its old padding fails its case here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Environment } from "@/types";

const ENVIRONMENT: Environment = {
	id: "env_1",
	name: "Staging",
	description: "",
	variables: {},
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const settled = { isLoading: false, isError: false, refetch: vi.fn() };
const queryState = {
	collections: { ...settled, data: [] as unknown[] },
	environments: { ...settled, data: [] as unknown[] },
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

/** The one left-edge class an element carries, or `undefined` if it has none. */
function insetClass(element: HTMLElement): string | undefined {
	return element.className.split(/\s+/).find((name) => name.startsWith("pl-"));
}

/**
 * What an environment row indents to, read off a rendered row. Renders its own
 * tree and puts the query state back, so a case can take the reference and then
 * set up the state it is actually about.
 */
function rowInsetClass(): string | undefined {
	const restore = queryState.environments;
	queryState.environments = { ...settled, data: [ENVIRONMENT] };
	const { unmount } = renderTree();
	const row = screen.getByText(ENVIRONMENT.name).closest('[role="treeitem"]');
	const inset = insetClass(row as HTMLElement);
	unmount();
	queryState.environments = restore;
	return inset;
}

describe("everything inside a section's group takes the row's left edge", () => {
	beforeEach(() => {
		queryState.collections = { ...settled, data: [] };
		queryState.environments = { ...settled, data: [] };
	});

	it("indents an environment row past the header, which is the edge the rest follow", () => {
		// The reference the cases below compare against has to be a real class,
		// or every one of them would pass on two `undefined`s.
		expect(rowInsetClass()).toBeTruthy();
	});

	it("indents the empty line", () => {
		const expected = rowInsetClass();
		renderTree();

		expect(insetClass(screen.getByText("No environments"))).toBe(expected);
		expect(insetClass(screen.getByText("No collections"))).toBe(expected);
	});

	it("indents the new-environment field", () => {
		const expected = rowInsetClass();
		renderTree();

		fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
		const field = screen.getByPlaceholderText("Environment name");

		expect(insetClass(field.parentElement as HTMLElement)).toBe(expected);
	});

	it("indents the loading skeleton", () => {
		const expected = rowInsetClass();
		queryState.environments = { ...settled, data: [], isLoading: true };
		renderTree();

		expect(insetClass(screen.getByRole("status", { name: "Loading" }))).toBe(expected);
	});

	it("indents the failure line", () => {
		const expected = rowInsetClass();
		queryState.environments = { ...settled, data: [], isError: true };
		renderTree();

		const error = screen.getByText("Couldn't load environments").parentElement;
		expect(insetClass(error as HTMLElement)).toBe(expected);
	});
});
