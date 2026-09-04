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
 * The left padding an element contributes, in Tailwind spacing steps, from a
 * `pl-*` or - when it has none - the `px-*` that sets both sides.
 *
 * Needed only for the skeleton, whose left edge is two elements' padding added
 * together. Everywhere else a single class is the whole answer and the cases
 * compare classes directly.
 */
function leftPaddingSteps(element: HTMLElement): number {
	const classes = element.className.split(/\s+/);
	const left = classes.find((name) => name.startsWith("pl-"));
	const both = classes.find((name) => name.startsWith("px-"));
	const value = Number((left ?? both ?? "").replace(/^p[lx]-/, ""));
	if (!Number.isFinite(value)) throw new Error(`no left padding on: ${element.className}`);
	return value;
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

	it("indents the loading skeleton's bars, not just the box around them", () => {
		// `ListSkeleton` pads every bar it draws with its own `px-2`, inside
		// whatever the caller sets on the wrapper, so the wrapper carrying the
		// row's inset put the bars 8px right of the rows they stand in for. The
		// two paddings are what the eye adds up, so the test adds them too.
		const expectedSteps = Number(rowInsetClass()?.replace("pl-", ""));
		queryState.environments = { ...settled, data: [], isLoading: true };
		renderTree();

		const wrapper = screen.getByRole("status", { name: "Loading" });
		const bar = wrapper.querySelector(".flex") as HTMLElement;
		expect(bar).toBeTruthy();
		expect(leftPaddingSteps(wrapper) + leftPaddingSteps(bar)).toBe(expectedSteps);
	});

	it("indents the failure line", () => {
		const expected = rowInsetClass();
		queryState.environments = { ...settled, data: [], isError: true };
		renderTree();

		const error = screen.getByText("Couldn't load environments").parentElement;
		expect(insetClass(error as HTMLElement)).toBe(expected);
	});
});
