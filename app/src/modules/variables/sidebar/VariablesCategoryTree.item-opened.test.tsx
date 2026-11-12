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
import { render, screen, fireEvent } from "@testing-library/react";
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

const idle = { isLoading: false, isError: false, refetch: vi.fn() };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ ...idle, data: [] }),
	useEnvironmentsQuery: () => ({ ...idle, data: [STAGING] }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
});
