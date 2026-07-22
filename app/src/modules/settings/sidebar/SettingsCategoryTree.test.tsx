import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsCategoryTree from "./SettingsCategoryTree";
import { useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";

const refetch = vi.fn();
const configQuery = {
	data: undefined as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch,
};

// The engine /config query is irrelevant to the App Settings rows below - those
// render client-side - but the Engine Settings section is driven entirely by it.
vi.mock("@/queries", () => ({
	useConfigQuery: () => configQuery,
}));

function renderTree() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<SettingsCategoryTree />
		</QueryClientProvider>
	);
}

describe("SettingsCategoryTree", () => {
	beforeEach(() => {
		refetch.mockClear();
		configQuery.data = undefined;
		configQuery.isLoading = false;
		configQuery.error = null;
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useSettingsStore.setState({ selectedCategory: null });
	});

	// The tree now lives in the Drawer, so selecting a category must open the
	// settings tab itself (it used to be rendered inside that tab).
	it("selects the category and opens the settings tab", () => {
		renderTree();
		fireEvent.click(screen.getByRole("button", { name: /Appearance/i }));

		expect(useSettingsStore.getState().selectedCategory).toBe("appearance");
		const { openTabs } = useTabsStore.getState();
		expect(openTabs).toHaveLength(1);
		expect(openTabs[0].type).toBe("settings");
	});

	/*
	 * The engine section used to fail into a static two-line notice. The engine
	 * is a sidecar that restarts, so "unavailable" is routinely temporary - but
	 * nothing in the sidebar re-asked, leaving app relaunch as the only recovery.
	 */
	it("offers a retry when the engine settings fail to load", () => {
		configQuery.error = new Error("connect ECONNREFUSED 127.0.0.1:9876");
		renderTree();

		expect(screen.getByText(/couldn't load engine settings/i)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	// App Settings are client-side; a dead engine must not take them with it.
	it("keeps the App Settings rows usable while the engine is down", () => {
		configQuery.error = new Error("engine down");
		renderTree();

		expect(screen.getByRole("button", { name: /Appearance/i })).toBeTruthy();
	});
});
