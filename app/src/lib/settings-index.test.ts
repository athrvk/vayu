/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The corpus behind the settings search - and, when #527 lands, the palette's
 * settings source. Pure functions, so this file asserts the contract both UIs
 * depend on: what is findable, what a result points at, and that an empty query
 * is "not searching" rather than "no matches".
 */

import { describe, it, expect } from "vitest";
import { buildSettingsIndex, searchSettings } from "./settings-index";

const panels = [
	{ id: "general" as const, label: "General", description: "Storage locations and app info" },
	// The panel's real copy, deliberately: it never says "theme", "color" or
	// "font", which is exactly why indexing panels alone found nothing.
	{
		id: "appearance" as const,
		label: "Appearance",
		description: "Customize the look and feel of the application",
	},
];

const engineCategories = [
	{ id: "database_performance" as const, label: "Database Performance" },
	{ id: "network_performance" as const, label: "Network & Connectivity" },
];

const engineEntries = [
	{
		key: "dbCacheSize",
		label: "Cache Size",
		description: "Memory SQLite keeps for pages it has already read.",
		category: "database_performance",
	},
	{
		key: "defaultTimeout",
		label: "Default Timeout",
		description: "How long a request waits before it is abandoned.",
		category: "network_performance",
	},
	{
		key: "orphanKey",
		label: "Orphan",
		description: "Belongs to a category the sidebar does not render.",
		category: "category_that_does_not_exist",
	},
];

const appSettings = [
	{
		anchor: "theme-mode",
		panel: "appearance" as const,
		label: "Theme Mode",
		description: "The app's light or dark palette.",
		keywords: ["dark mode"],
	},
	{
		anchor: "orphan-setting",
		panel: "not-a-panel" as never,
		label: "Orphan",
		description: "Belongs to a panel that is not registered.",
	},
];

const index = buildSettingsIndex({ panels, appSettings, engineEntries, engineCategories });

describe("buildSettingsIndex", () => {
	it("holds all three catalogues, panels first and in declaration order", () => {
		expect(index.map((e) => e.id)).toEqual([
			"general",
			"appearance",
			"theme-mode",
			"dbCacheSize",
			"defaultTimeout",
		]);
	});

	it("indexes the settings inside a panel, not only the panel", () => {
		/*
		 * The defect this catalogue exists for: with panels alone, "theme"
		 * matched nothing, because the panel that holds Theme Mode is called
		 * "Appearance" and describes itself as the look and feel of the app.
		 */
		const panelsOnly = buildSettingsIndex({ panels, engineEntries, engineCategories });
		expect(searchSettings(panelsOnly, "theme")).toEqual([]);
		expect(searchSettings(index, "theme").map((e) => e.id)).toEqual(["theme-mode"]);
	});

	it("carries the anchor a consumer reveals, and none on a whole panel", () => {
		expect(index.find((e) => e.id === "theme-mode")?.anchor).toBe("theme-mode");
		expect(index.find((e) => e.id === "dbCacheSize")?.anchor).toBe("dbCacheSize");
		expect(index.find((e) => e.id === "appearance")?.anchor).toBeUndefined();
	});

	it("drops an app setting whose panel is not registered", () => {
		expect(index.find((e) => e.id === "orphan-setting")).toBeUndefined();
	});

	it("drops an entry whose category has no row to navigate to", () => {
		// Keeping it would put a result on screen that leads nowhere: selecting
		// its category would show an empty settings view.
		expect(index.find((e) => e.id === "orphanKey")).toBeUndefined();
	});

	it("points each result at the category that reveals it", () => {
		const cacheSize = index.find((e) => e.id === "dbCacheSize");
		expect(cacheSize?.category).toBe("database_performance");
		expect(cacheSize?.categoryLabel).toBe("Database Performance");
		expect(cacheSize?.kind).toBe("engine");

		const general = index.find((e) => e.id === "general");
		expect(general?.category).toBe("general");
		expect(general?.kind).toBe("panel");
	});
});

describe("searchSettings", () => {
	it("returns everything for an empty or whitespace query", () => {
		// The sidebar reads this as "not searching" and renders its normal two
		// sections; a filtered-to-nothing list would blank the drawer.
		expect(searchSettings(index, "")).toHaveLength(index.length);
		expect(searchSettings(index, "   ")).toHaveLength(index.length);
	});

	it("finds a setting by its engine key, which is how docs and logs name it", () => {
		const hits = searchSettings(index, "dbcachesize");
		expect(hits.map((h) => h.id)).toEqual(["dbCacheSize"]);
	});

	it("finds a setting by words only its description carries", () => {
		const hits = searchSettings(index, "abandoned");
		expect(hits.map((h) => h.id)).toEqual(["defaultTimeout"]);
	});

	it("ranks a name match above a description mention", () => {
		/*
		 * "cache" is in `dbCacheSize`'s label and in nothing else's, while
		 * "size" appears in a label and could appear in prose - ranking is what
		 * stops the row you typed the name of from sitting under a paragraph
		 * that happens to mention it.
		 */
		const withDescriptionMention = buildSettingsIndex({
			panels: [
				{
					id: "appearance" as const,
					label: "Appearance",
					description: "Also mentions the cache, incidentally.",
				},
			],
			engineEntries: [engineEntries[0]],
			engineCategories,
		});

		const hits = searchSettings(withDescriptionMention, "cache");
		expect(hits.map((h) => h.id)).toEqual(["dbCacheSize", "appearance"]);
	});

	it("matches keywords, for the words a user types that the copy never uses", () => {
		// "dark mode" is what the setting is called everywhere except in Vayu,
		// where the label reads "Theme Mode" and the options are System/Light/Dark.
		expect(searchSettings(index, "dark mode").map((e) => e.id)).toEqual(["theme-mode"]);
	});

	it("ranks a label match above a keyword match above a description mention", () => {
		// Declared in the losing order, so passing cannot be an accident of
		// declaration order surviving an unsorted list.
		const ranked = buildSettingsIndex({
			panels: [{ id: "appearance" as const, label: "Appearance", description: "" }],
			appSettings: [
				{
					anchor: "by-description",
					panel: "appearance" as const,
					label: "Something else",
					description: "Mentions zebra in passing.",
				},
				{
					anchor: "by-keyword",
					panel: "appearance" as const,
					label: "Another thing",
					description: "No mention here.",
					keywords: ["zebra"],
				},
				{
					anchor: "by-label",
					panel: "appearance" as const,
					label: "Zebra",
					description: "No mention here either.",
				},
			],
			engineEntries: [],
			engineCategories,
		});

		expect(searchSettings(ranked, "zebra").map((e) => e.id)).toEqual([
			"by-label",
			"by-keyword",
			"by-description",
		]);
	});

	it("matches case-insensitively and returns nothing for a miss", () => {
		// The panel first, then the settings it holds - they match on the
		// category label, which ranks last.
		expect(searchSettings(index, "APPEARANCE").map((h) => h.id)).toEqual([
			"appearance",
			"theme-mode",
		]);
		expect(searchSettings(index, "zzzz")).toEqual([]);
	});
});
