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
 * The environment menu is open when `useEnvSwitcherStore` says so (#2115), and
 * its own open and close land in the store: that is what lets a toast action
 * raised outside the title bar open it.
 *
 * The platform flags in `TitleBar` are read at import time, so the platform is
 * stubbed before a fresh import, as `TitleBar.navigation.test.tsx` does; the
 * store is imported from the same graph for the same reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: [{ id: "env-1", name: "Staging" }] }),
}));

async function renderBar() {
	Object.defineProperty(window, "electronAPI", {
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
	vi.resetModules();
	const [{ default: TitleBar }, { useEnvSwitcherStore }, { TooltipProvider }] = await Promise.all(
		[import("./TitleBar"), import("@/stores"), import("@/components/ui")]
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TitleBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { useEnvSwitcherStore };
}

const menuItem = () => screen.queryByRole("menuitem", { name: "Staging" });

beforeEach(cleanup);
afterEach(() => vi.resetModules());

describe("the title bar's environment menu", () => {
	it("stays closed until something opens it", async () => {
		const { useEnvSwitcherStore } = await renderBar();

		expect(useEnvSwitcherStore.getState().isOpen).toBe(false);
		expect(menuItem()).not.toBeInTheDocument();
	});

	// Mutation check: render `<DropdownMenu>` without `open={menuOpen}` and the
	// store write below no longer opens the menu.
	it("opens when the store says so, which is how a toast action reaches it", async () => {
		const { useEnvSwitcherStore } = await renderBar();

		useEnvSwitcherStore.getState().setOpen(true);

		await waitFor(() => expect(menuItem()).toBeInTheDocument());
	});

	// Mutation check: drop `onOpenChange={setMenuOpen}` and the store stays
	// `false` after the user opens the menu, so a later toast action would find
	// the flag already unset and could not tell the menu was showing.
	it("writes the user's own open and close back to the store", async () => {
		const { useEnvSwitcherStore } = await renderBar();

		fireEvent.keyDown(screen.getByRole("button", { name: /Environment:/ }), { key: "Enter" });
		await waitFor(() => expect(menuItem()).toBeInTheDocument());
		expect(useEnvSwitcherStore.getState().isOpen).toBe(true);

		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
		await waitFor(() => expect(menuItem()).not.toBeInTheDocument());
		expect(useEnvSwitcherStore.getState().isOpen).toBe(false);
	});
});
