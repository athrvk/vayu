import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsCategoryTree from "./SettingsCategoryTree";
import { useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";

// The engine /config query is irrelevant here — App Settings render client-side.
vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: undefined, isLoading: false, error: null }),
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
});
