/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Individual settings, as palette results.
 *
 * The registry already offers one command per settings *section*, which reaches
 * the twelve screens. This reaches the ~65 entries on them: a user who knows
 * the app has a request timeout should not have to guess which of five engine
 * categories owns it, and `dbCacheSize` - the name every doc, log line and MCP
 * call uses - should find its row even though the screen labels it "Cache Size".
 *
 * Two things it deliberately does not do:
 *
 * - **It does not index panels.** `SettingsIndexEntry` has a `panel` kind, and
 *   the command registry already generates a command per panel from the same
 *   registry; indexing them here would put every settings screen in the group
 *   twice, under two rows that do the same thing.
 * - **It does not own a matcher.** `searchSettings` is the sidebar's ranking,
 *   and a palette that ranked settings differently from the settings sidebar
 *   would be two answers to one question. One index, one ranking, two UIs.
 */

import { useMemo } from "react";
import { Search } from "lucide-react";
import { useLayoutStore, useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { revealSetting } from "@/modules/settings/reveal";
import { useSettingsIndex } from "@/modules/settings/useSettingsIndex";
import { searchSettings, type SettingsIndexEntry } from "@/lib/settings-index";
import { DEEP_GROUP_LIMIT, type PaletteItem } from "../types";

/**
 * Reveal one settings entry, through the shared `revealSetting` - the same call
 * the sidebar's own result rows, the registry's section commands and the
 * curl-paste ledger's pointers make.
 */
function reveal(entry: SettingsIndexEntry): void {
	revealSetting(entry.category, entry.anchor);
}

export function useSettingsItems(query: string): PaletteItem[] {
	const index = useSettingsIndex();
	const needle = query.trim();

	return useMemo(() => {
		// Deep search is search. The palette's empty state answers "what was I
		// just doing", and sixty-five settings rows are not that.
		if (needle === "") return [];

		const matches = searchSettings(index, needle).filter((entry) => entry.kind !== "panel");
		const shown = matches.slice(0, DEEP_GROUP_LIMIT);

		const items: PaletteItem[] = shown.map((entry) => ({
			id: `setting:${entry.kind}:${entry.id}`,
			kind: "settings" as const,
			// `searchSettings` matched this against the whole index entry,
			// description included - see `PaletteItem.preMatched`.
			preMatched: true,
			title: entry.label,
			// The engine key is part of what the row says, because that is what
			// docs, logs and MCP calls name the setting; an app setting has no
			// such name, so its subtitle is just the panel that holds it.
			subtitle:
				entry.kind === "engine"
					? `${entry.categoryLabel} · ${entry.id}`
					: entry.categoryLabel,
			// The terms someone types to reach this row: the engine key every
			// doc and log line names it by, and its aliases. The description
			// used to be here too - a whole sentence of prose, carried only so
			// cmdk's second filter could not hide a row this source had already
			// matched. Nothing filters these rows twice now (`ranking.ts`), so
			// the defensive half is gone and what remains is search terms.
			keywords: [entry.id, ...entry.keywords],
			perform: () => reveal(entry),
		}));

		// Only when there is more, and never as a consolation prize: an escape
		// row over an exhausted result set would send the user to a surface that
		// shows them the same rows again.
		if (matches.length > shown.length) {
			items.push({
				id: "setting:search-more",
				kind: "settings" as const,
				title: `Search settings for “${needle}”…`,
				subtitle: `${matches.length} matches`,
				icon: Search,
				escape: true,
				perform: () => {
					// The sidebar's box reads this, so the drawer opens already
					// filtered - the palette finds, the destination browses.
					useSettingsStore.getState().setSearchQuery(needle);
					useLayoutStore.getState().setDrawerOpen(true);
					useLayoutStore.getState().setDrawerView("settings");
					useTabsStore.getState().openTab({ type: "settings", entityId: null });
				},
			});
		}

		return items;
	}, [index, needle]);
}
