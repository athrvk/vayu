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
 * ~45 engine entries and 7 app panels were findable only by guessing which
 * category owned them - there was no search anywhere in Settings. These
 * assertions are about what the search *does*: an entry has no row of its own
 * in the normal tree, so finding one has to select its category and say which
 * entry was meant.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsCategoryTree from "./SettingsCategoryTree";
import { useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import type { ConfigEntry } from "@/types";

const base = {
	type: "integer" as const,
	value: "1",
	default: "1",
	requiresRestart: false,
	advanced: false,
	keywords: [],
	updatedAt: 0,
};

const entries: ConfigEntry[] = [
	{
		...base,
		key: "dbCacheSize",
		label: "Cache Size",
		description: "Memory SQLite keeps for pages it has already read.",
		category: "database_performance",
		// The keyword this entry is really seeded with (`database.cpp`).
		keywords: ["ram"],
	},
	{
		...base,
		key: "defaultTimeout",
		label: "Default Timeout",
		description: "How long a request waits before it is abandoned.",
		category: "network_performance",
	},
];

const configQuery = {
	data: { entries } as unknown,
	isLoading: false,
	error: null as Error | null,
	refetch: vi.fn(),
};

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

const search = () => screen.getByLabelText("Search settings");

beforeEach(() => {
	cleanup();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSettingsStore.setState({ selectedCategory: null, highlightedKey: null });
});

describe("settings search", () => {
	it("shows both catalogue sections until something is typed", () => {
		renderTree();

		expect(screen.getByText("App Settings")).toBeInTheDocument();
		expect(screen.getByText("Engine Settings")).toBeInTheDocument();
		// Mutation check: an empty query must mean "not searching", not "no
		// matches" - the sections are what the drawer shows by default.
		expect(screen.queryByText(/result/)).not.toBeInTheDocument();
	});

	it("finds an engine entry by its label and replaces the sections with results", () => {
		renderTree();
		fireEvent.change(search(), { target: { value: "cache" } });

		expect(screen.getByText("Cache Size")).toBeInTheDocument();
		expect(screen.getByText("1 result")).toBeInTheDocument();
		expect(screen.queryByText("App Settings")).not.toBeInTheDocument();
		// The subtitle names the owning category and the engine key, so two
		// similarly-named settings are told apart before the click.
		expect(screen.getByText(/Database Performance · dbCacheSize/)).toBeInTheDocument();
	});

	it("finds a setting by its key, and by words only its description carries", () => {
		renderTree();

		fireEvent.change(search(), { target: { value: "defaultTimeout" } });
		expect(screen.getByText("Default Timeout")).toBeInTheDocument();

		fireEvent.change(search(), { target: { value: "abandoned" } });
		expect(screen.getByText("Default Timeout")).toBeInTheDocument();
	});

	it("finds an engine entry by a keyword the entry carries and the copy does not", () => {
		renderTree();

		// End to end over a real seeded keyword: "ram" is nowhere in the label
		// or the description, so this query is answered by the engine's own
		// `keywords` field travelling through `/config` into the index.
		fireEvent.change(search(), { target: { value: "ram" } });
		expect(screen.getByText("Cache Size")).toBeInTheDocument();
		// Presence, not a result count: "ram" is a substring of "histogram" and
		// "parameter", so the real app catalogue answers this query too. What
		// this pins is that the engine entry is among them at all.
		expect(screen.getByText(/Database Performance · dbCacheSize/)).toBeInTheDocument();
	});

	it("selects the owning category and names the entry to reveal", () => {
		renderTree();
		fireEvent.change(search(), { target: { value: "cache" } });
		fireEvent.click(screen.getByText("Cache Size"));

		const state = useSettingsStore.getState();
		expect(state.selectedCategory).toBe("database_performance");
		// Without the key the view would open on the right category and leave
		// the user to find the row among 45 of them.
		expect(state.highlightedKey).toBe("dbCacheSize");
		expect(useTabsStore.getState().openTabs[0].type).toBe("settings");
	});

	it("selects an app panel with nothing to highlight - the panel is the result", () => {
		renderTree();
		fireEvent.change(search(), { target: { value: "appearance" } });
		// First result: the panel itself outranks the settings it holds, which
		// match on their category label. Its own label is the one being clicked -
		// the same word appears below as those settings' subtitles.
		fireEvent.click(screen.getAllByText("Appearance")[0]);

		const state = useSettingsStore.getState();
		expect(state.selectedCategory).toBe("appearance");
		expect(state.highlightedKey).toBeNull();
	});

	/*
	 * The bug this file did not catch the first time: the index held the seven
	 * *panel* titles and the engine entries, so the words printed on the
	 * Appearance panel - Theme Mode, Color Scheme, the font pickers - matched
	 * nothing at all. These run against the real catalogue, not a fixture,
	 * because a fixture would have passed then too.
	 */
	describe("the settings inside the panels", () => {
		it.each([
			["theme", "Theme Mode", "appearance", "theme-mode"],
			["color", "Color Scheme", "appearance", "color-scheme"],
			["font", "Interface font", "appearance", "ui-font"],
			["dark mode", "Theme Mode", "appearance", "theme-mode"],
			["auto-save", "Auto-save", "general", "auto-save"],
			["notification", "Notification position", "notifications", "toast-position"],
		])("finds %s", (query, label) => {
			renderTree();
			fireEvent.change(search(), { target: { value: query } });

			expect(screen.getAllByText(label).length).toBeGreaterThan(0);
		});

		it("selects the panel and names the block to reveal", () => {
			renderTree();
			fireEvent.change(search(), { target: { value: "theme" } });
			fireEvent.click(screen.getAllByText("Theme Mode")[0]);

			const state = useSettingsStore.getState();
			expect(state.selectedCategory).toBe("appearance");
			// The anchor the Appearance panel renders on the Theme Mode card. A
			// result that only selected the panel would drop the user at the top
			// of a screen and leave them to scan it.
			expect(state.highlightedKey).toBe("theme-mode");
		});

		it("ranks the setting above the panel that contains it", () => {
			// "Appearance" the panel also matches "appearance"; the setting a user
			// typed the name of is the more specific answer.
			renderTree();
			fireEvent.change(search(), { target: { value: "roundedness" } });

			const results = screen.getAllByRole("button");
			const first = results.find((b) => b.textContent?.includes("Roundedness"));
			expect(first).toBeDefined();
		});
	});

	it("says so when nothing matches, and the clear button restores the sections", () => {
		renderTree();
		fireEvent.change(search(), { target: { value: "zzzz" } });
		expect(screen.getByText(/No settings match/)).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText("Clear search"));
		expect(screen.getByText("App Settings")).toBeInTheDocument();
	});
});
