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
 * The environment switcher only lists and switches existing environments.
 * These two quick actions wire in pipelines that already exist elsewhere in
 * the app (the Variables sidebar's create flow, the global import dialog)
 * rather than building new ones - see `VariablesCategoryTree.handleCreateEnvironment`
 * for the pattern "New Environment" mirrors: create, then point the Variables
 * editor's selected category at the new environment. It deliberately does not
 * activate the environment - creating one should not change what is live.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.hoisted(() => {
	Object.defineProperty(globalThis.window, "electronAPI", {
		value: {
			platform: "linux",
			windowIsMaximized: () => Promise.resolve(false),
			onWindowMaximized: () => () => {},
			windowMinimize: () => {},
			windowMaximize: () => {},
			windowClose: () => {},
		},
		writable: true,
		configurable: true,
	});
});

import { useToastStore, useSessionStore, useTabsStore, useImportModalStore } from "@/stores";
import { useVariablesStore } from "@/modules/variables/variables-store";
import TitleBar from "./TitleBar";
import { TooltipProvider } from "@/components/ui";

const environments = [{ id: "env-1", name: "Staging" }];

const createEnvironment = vi.fn();
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: environments }),
	useCreateEnvironmentMutation: () => ({ mutateAsync: createEnvironment, isPending: false }),
}));

function renderTitleBar() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TitleBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function openMenu() {
	const trigger = screen.getByRole("button", { name: /switch environment/i });
	fireEvent.keyDown(trigger, { key: "Enter" });
	const menu = screen.getByRole("menu");
	expect(menu).toBeInTheDocument();
	return within(menu);
}

beforeEach(() => {
	cleanup();
	useToastStore.setState({ toasts: [] });
	useSessionStore.setState({ activeEnvironmentId: null });
	useTabsStore.setState({ openTabs: [], activeTabId: null, navHistory: [], navIndex: -1 });
	useVariablesStore.setState({ selectedCategory: null });
	useImportModalStore.setState({ isOpen: false, pendingPath: null });
	createEnvironment.mockReset();
	createEnvironment.mockResolvedValue({ id: "env-new", name: "New Environment" });
});

describe("environment switcher quick actions", () => {
	it("creates a new environment and opens the Variables editor on it, without activating it", async () => {
		renderTitleBar();
		const menu = openMenu();
		fireEvent.click(menu.getByText("New Environment"));

		expect(createEnvironment).toHaveBeenCalledWith({ name: "New Environment", variables: {} });
		await vi.waitFor(() =>
			expect(useVariablesStore.getState().selectedCategory).toEqual({
				type: "environment",
				environmentId: "env-new",
			})
		);
		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "variables", entityId: null })
		);
		// Creating must not switch what is live.
		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
	});

	it("opens the import dialog from Import Environment...", () => {
		renderTitleBar();
		const menu = openMenu();
		fireEvent.click(menu.getByText("Import Environment..."));

		expect(useImportModalStore.getState().isOpen).toBe(true);
	});
});
