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
 * Picking a scope opens the variables tab, and tells the drawer so an overlay
 * can leave (#3507).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { DrawerItemOpenedProvider } from "@/components/layout/drawer-item-opened";
import VariablesCategoryTree from "./VariablesCategoryTree";
import type { Environment } from "@/types";

const STAGING = {
	id: "env_1",
	name: "Staging",
	variables: {},
	isActive: false,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
} as unknown as Environment;

const createEnvironment = vi.fn();

const idle = { isLoading: false, isError: false, refetch: vi.fn() };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...idle, data: [] }),
	useEnvironmentsQuery: () => ({ ...idle, data: [STAGING] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: createEnvironment, isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const openTab = vi.fn();
vi.mock("@/stores", () => ({
	useTabsStore: (select: (s: { openTab: typeof openTab }) => unknown) => select({ openTab }),
	useSaveStore: (select: (s: Record<string, unknown>) => unknown) =>
		select({ reportSaving: vi.fn(), reportSaved: vi.fn(), discard: vi.fn() }),
	useToastStore: (select: (s: { showToast: () => void }) => unknown) =>
		select({ showToast: vi.fn() }),
	useLayoutStore: (select: (s: { revealDrawerView: () => void }) => unknown) =>
		select({ revealDrawerView: vi.fn() }),
}));
vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: (
		select: (s: { selectedCategory: null; setSelectedCategory: () => void }) => unknown
	) => select({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

const onItemOpened = vi.fn();

function renderTree() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<DrawerItemOpenedProvider value={onItemOpened}>
					<VariablesCategoryTree />
				</DrawerItemOpenedProvider>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	createEnvironment.mockReset().mockResolvedValue({ ...STAGING, id: "env_new", name: "Fresh" });
	openTab.mockClear();
	onItemOpened.mockClear();
});

describe("the variables tree's selection", () => {
	it.each(["Globals", "Staging"])("tells the drawer after %s opens the tab", (name) => {
		renderTree();
		fireEvent.click(screen.getByText(name));
		expect(openTab).toHaveBeenCalledWith({ type: "variables", entityId: null });
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});

	// A created environment is selected the same way, so the overlay leaves for it too.
	it("tells the drawer after a new environment is created and opened", async () => {
		renderTree();
		fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
		const field = screen.getByPlaceholderText("Environment name");
		fireEvent.change(field, { target: { value: "Fresh" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(onItemOpened).toHaveBeenCalledTimes(1));
		expect(createEnvironment).toHaveBeenCalledWith({ name: "Fresh", variables: {} });
		expect(openTab).toHaveBeenCalledWith({ type: "variables", entityId: null });
	});

	it("does not when the create fails and nothing opens", async () => {
		createEnvironment.mockRejectedValue(new Error("boom"));
		renderTree();
		fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
		const field = screen.getByPlaceholderText("Environment name");
		fireEvent.change(field, { target: { value: "Fresh" } });
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(createEnvironment).toHaveBeenCalled());
		expect(onItemOpened).not.toHaveBeenCalled();
	});
});
