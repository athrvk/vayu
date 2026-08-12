/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings search index
 *
 * One searchable corpus over both halves of Settings: the client panels
 * (declared in the app-panels registry) and the engine entries the `/config`
 * API sends. Pure data in, pure data out - no React, no stores - so the
 * sidebar's search and the command palette's settings source (#527) share one
 * index rather than each growing its own matcher.
 *
 * Entries are matched on label, description and id. The id matters: an engine
 * setting is called `dbCacheSize` in every doc, log line and MCP tool call, so
 * typing that must find it even though the visible label reads "Cache Size".
 */

import type { SettingsCategory } from "@/types";

/** Where a result lives: a whole client panel, or one engine entry inside one. */
export type SettingsIndexKind = "panel" | "engine";

export interface SettingsIndexEntry {
	/** The panel id, or the engine entry key. Unique across the index. */
	id: string;
	kind: SettingsIndexKind;
	label: string;
	description: string;
	/** The category to select in order to reveal this result. */
	category: SettingsCategory;
	/** Human name of that category, for the result's subtitle. */
	categoryLabel: string;
}

/** The app-panel fields the index needs (a structural subset of `AppSettingsPanel`). */
export interface SettingsPanelSource {
	id: SettingsCategory;
	label: string;
	description: string;
}

/** The engine-entry fields the index needs (a structural subset of `ConfigEntry`). */
export interface SettingsEngineEntrySource {
	key: string;
	label: string;
	description: string;
	category: string;
}

/** The engine-category fields the index needs (a subset of the category registry). */
export interface SettingsEngineCategorySource {
	id: SettingsCategory;
	label: string;
}

interface BuildSettingsIndexInput {
	panels: readonly SettingsPanelSource[];
	engineEntries: readonly SettingsEngineEntrySource[];
	engineCategories: readonly SettingsEngineCategorySource[];
}

/**
 * Flatten the two catalogues into one list, in the order they are declared.
 *
 * An engine entry whose category is not in the registry is dropped rather than
 * shown under a made-up heading: it has no row in the sidebar to navigate to,
 * so a result for it would lead nowhere.
 */
export function buildSettingsIndex({
	panels,
	engineEntries,
	engineCategories,
}: BuildSettingsIndexInput): SettingsIndexEntry[] {
	const categoryLabels = new Map(engineCategories.map((c) => [c.id as string, c.label]));

	const index: SettingsIndexEntry[] = panels.map((panel) => ({
		id: panel.id,
		kind: "panel",
		label: panel.label,
		description: panel.description,
		category: panel.id,
		categoryLabel: panel.label,
	}));

	for (const entry of engineEntries) {
		const categoryLabel = categoryLabels.get(entry.category);
		if (categoryLabel === undefined) continue;
		index.push({
			id: entry.key,
			kind: "engine",
			label: entry.label,
			description: entry.description,
			category: entry.category as SettingsCategory,
			categoryLabel,
		});
	}

	return index;
}

/**
 * Rank so an exact-ish name match cannot sit below a description mention.
 *
 * Numbers are compared, never displayed; lower sorts first.
 */
function matchRank(entry: SettingsIndexEntry, query: string): number | null {
	const label = entry.label.toLowerCase();
	const id = entry.id.toLowerCase();
	if (label.startsWith(query)) return 0;
	if (id.startsWith(query)) return 1;
	if (label.includes(query)) return 2;
	if (id.includes(query)) return 3;
	if (entry.description.toLowerCase().includes(query)) return 4;
	if (entry.categoryLabel.toLowerCase().includes(query)) return 5;
	return null;
}

/**
 * Filter and rank the index for a query.
 *
 * An empty (or whitespace-only) query returns the index unchanged - the caller
 * uses that to mean "not searching" and renders its normal layout, so this must
 * never be a filtered-to-nothing list.
 */
export function searchSettings(
	index: readonly SettingsIndexEntry[],
	query: string
): SettingsIndexEntry[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...index];

	const ranked: { entry: SettingsIndexEntry; rank: number; order: number }[] = [];
	index.forEach((entry, order) => {
		const rank = matchRank(entry, needle);
		if (rank !== null) ranked.push({ entry, rank, order });
	});

	// Declaration order breaks ties, so a query that matches a whole category
	// lists it the way the sidebar does rather than alphabetically.
	ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
	return ranked.map((r) => r.entry);
}
