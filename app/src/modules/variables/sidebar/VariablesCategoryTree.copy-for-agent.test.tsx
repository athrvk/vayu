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
 * "Copy for agent" on an environment row (#2047).
 *
 * An environment is the entity most likely to hold a secret, and its reference
 * names it by id alone: the variables the row is holding must not ride.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Environment } from "@/types";

const SENTINEL = "s3cr3t-sentinel";

const STAGING = {
	id: "env_1",
	name: "Staging",
	description: SENTINEL,
	variables: { API_KEY: { value: SENTINEL, type: "secret" } },
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Environment;

const idle = { isLoading: false, isError: false, refetch: vi.fn() };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...idle, data: [] }),
	useEnvironmentsQuery: () => ({ ...idle, data: [STAGING] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const showToast = vi.fn();
vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: { openTab: () => void }) => unknown) => select({ openTab: vi.fn() }),
	useSaveStore: (select: (s: Record<string, unknown>) => unknown) =>
		select({ startSaving: vi.fn(), completeSaveThenIdle: vi.fn(), failSave: vi.fn() }),
	useToastStore: (select: (s: { showToast: typeof showToast }) => unknown) =>
		select({ showToast }),
	useLayoutStore: (select: (s: { revealDrawerView: () => void }) => unknown) =>
		select({ revealDrawerView: vi.fn() }),
}));
vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: (
		select: (s: { selectedCategory: null; setSelectedCategory: () => void }) => unknown
	) => select({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	showToast.mockReset();
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

function openEnvironmentMenu() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<VariablesCategoryTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const row = within(screen.getByRole("tree", { name: "Variable scopes" }))
		.getAllByRole("treeitem")
		.find((item) => item.getAttribute("data-tree-label") === "Staging")!;
	fireEvent.contextMenu(row);
}

describe("Copy for agent on an environment row", () => {
	it("copies the reference line and says so", async () => {
		openEnvironmentMenu();

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu environment "Staging" (env_1)');
		await waitFor(() => expect(showToast).toHaveBeenCalledWith("Reference copied", "success"));
	});

	it("never carries the environment's variables", async () => {
		openEnvironmentMenu();

		fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0][0]).not.toContain(SENTINEL);
	});
});
