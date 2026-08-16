/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings search index
 *
 * One searchable corpus over all of Settings: the client panels (the app-panels
 * registry), the individual settings inside them (the app-settings catalogue)
 * and the engine entries the `/config` API sends. Pure data in, pure data out -
 * no React, no stores - so the sidebar's search and the command palette's
 * settings source (#527) share one index rather than each growing its own
 * matcher.
 *
 * **A panel is not its settings.** The first version of this index held panel
 * titles and engine entries only, so "theme", "color" and "font" - words
 * printed on the Appearance panel three times over - matched nothing, because
 * the panel is called "Appearance" and describes itself as "the look and feel
 * of the application". Indexing what a screen is *called* is not indexing what
 * it *contains*.
 *
 * Entries are matched on label, id, description and keywords. The id matters:
 * an engine setting is called `dbCacheSize` in every doc, log line and MCP tool
 * call, so typing that must find it even though the visible label reads
 * "Cache Size".
 */

import type { SettingsCategory } from "@/types";

/**
 * What a result is: a whole client panel, one setting inside one, or one engine
 * entry. The kind decides what a consumer does with it - a `panel` has no
 * `anchor` to reveal, the other two do.
 */
export type SettingsIndexKind = "panel" | "app-setting" | "engine";

export interface SettingsIndexEntry {
	/** The panel id, or the engine entry key. Unique across the index. */
	id: string;
	kind: SettingsIndexKind;
	label: string;
	/**
	 * One sentence about the entry. Display copy on the panel and engine halves
	 * (both render it on screen); on an `app-setting` it is the catalogue's
	 * written summary, because a panel's own copy is markup rather than a string.
	 */
	description: string;
	/** The category to select in order to reveal this result. */
	category: SettingsCategory;
	/** Human name of that category, for the result's subtitle. */
	categoryLabel: string;
	/**
	 * What the settings view scrolls to and outlines: the engine entry's key, or
	 * the app setting's `data-setting-anchor`. Absent on a `panel` result, which
	 * is the whole screen.
	 */
	anchor?: string;
	/** Extra match terms that appear in neither the label nor the description. */
	keywords: readonly string[];
}

/** The app-panel fields the index needs (a structural subset of `AppSettingsPanel`). */
export interface SettingsPanelSource {
	id: SettingsCategory;
	label: string;
	description: string;
}

/** The app-setting fields the index needs (a subset of `AppSettingDescriptor`). */
export interface SettingsAppSettingSource {
	anchor: string;
	panel: SettingsCategory;
	label: string;
	/**
	 * The app half has no description string to lend: a panel's copy is markup
	 * (`<Kbd>` chips, live counts, conditional notices), so the catalogue writes
	 * a one-sentence summary of the block instead. It is a summary, not a
	 * caption - see `app-settings.ts`.
	 */
	searchText: string;
	keywords?: readonly string[];
}

/** The engine-entry fields the index needs (a structural subset of `ConfigEntry`). */
export interface SettingsEngineEntrySource {
	key: string;
	label: string;
	description: string;
	category: string;
	/**
	 * Optional here, always sent by the engine (`config_entry_json`): a caller
	 * assembling an entry by hand - a test, a fixture - should not have to
	 * declare an empty list to say "none".
	 */
	keywords?: readonly string[];
}

/** The engine-category fields the index needs (a subset of the category registry). */
export interface SettingsEngineCategorySource {
	id: SettingsCategory;
	label: string;
}

/** Where an engine entry is edited when an app panel row owns it, not the engine list. */
export interface SettingsAppEditorLocation {
	panel: SettingsCategory;
	anchor: string;
}

interface BuildSettingsIndexInput {
	panels: readonly SettingsPanelSource[];
	/** The settings inside those panels. Omitted only by tests that do not need them. */
	appSettings?: readonly SettingsAppSettingSource[];
	engineEntries: readonly SettingsEngineEntrySource[];
	engineCategories: readonly SettingsEngineCategorySource[];
	/**
	 * Engine keys whose editor is an app panel row (`ENGINE_SETTINGS_EDITED_IN_APP`),
	 * keyed by engine key. Such an entry is folded into that row rather than
	 * indexed beside it - see the note on `buildSettingsIndex`.
	 */
	engineEntriesEditedInApp?: Readonly<Record<string, SettingsAppEditorLocation>>;
}

/**
 * Flatten the two catalogues into one list, in the order they are declared.
 *
 * An engine entry whose category is not in the registry is dropped rather than
 * shown under a made-up heading: it has no row in the sidebar to navigate to,
 * so a result for it would lead nowhere.
 *
 * An engine entry an app panel row edits (`engineEntriesEditedInApp`) is not a
 * result of its own either - it *becomes* a keyword on that row. One knob, one
 * result, one editor: indexing both would put two rows for one value back in
 * front of the user, which is the thing dropping the second editor fixed. Its
 * key still finds it, because that is the name the docs, the logs and the MCP
 * tool use.
 */
export function buildSettingsIndex({
	panels,
	appSettings = [],
	engineEntries,
	engineCategories,
	engineEntriesEditedInApp = {},
}: BuildSettingsIndexInput): SettingsIndexEntry[] {
	const categoryLabels = new Map(engineCategories.map((c) => [c.id as string, c.label]));
	const panelLabels = new Map(panels.map((p) => [p.id as string, p.label]));

	const index: SettingsIndexEntry[] = panels.map((panel) => ({
		id: panel.id,
		kind: "panel",
		label: panel.label,
		description: panel.description,
		category: panel.id,
		categoryLabel: panel.label,
		keywords: [],
	}));

	// Engine keys that belong to an app row, grouped by the row that owns them,
	// so the row can carry each as a match term.
	const foldedKeys = new Map<string, string[]>();
	for (const [engineKey, editor] of Object.entries(engineEntriesEditedInApp)) {
		const rowId = `${editor.panel}:${editor.anchor}`;
		foldedKeys.set(rowId, [...(foldedKeys.get(rowId) ?? []), engineKey]);
	}

	for (const setting of appSettings) {
		const panelLabel = panelLabels.get(setting.panel);
		// Same rule as an engine entry in an unknown category: with no row in the
		// sidebar to navigate to, a result for it would lead nowhere.
		if (panelLabel === undefined) continue;
		index.push({
			id: setting.anchor,
			kind: "app-setting",
			label: setting.label,
			description: setting.searchText,
			category: setting.panel,
			categoryLabel: panelLabel,
			anchor: setting.anchor,
			keywords: [
				...(setting.keywords ?? []),
				...(foldedKeys.get(`${setting.panel}:${setting.anchor}`) ?? []),
			],
		});
	}

	for (const entry of engineEntries) {
		if (entry.key in engineEntriesEditedInApp) continue;
		const categoryLabel = categoryLabels.get(entry.category);
		if (categoryLabel === undefined) continue;
		index.push({
			id: entry.key,
			kind: "engine",
			label: entry.label,
			description: entry.description,
			category: entry.category as SettingsCategory,
			categoryLabel,
			anchor: entry.key,
			keywords: entry.keywords ?? [],
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
	if (entry.keywords.some((keyword) => keyword.toLowerCase().includes(query))) return 4;
	if (entry.description.toLowerCase().includes(query)) return 5;
	if (entry.categoryLabel.toLowerCase().includes(query)) return 6;
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
