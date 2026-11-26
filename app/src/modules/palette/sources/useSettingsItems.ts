/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Individual settings, as palette results. The registry offers one command per settings section
 * (the twelve screens); this reaches the ~65 entries on them, so a user need not guess which of
 * five engine categories owns the request timeout, and `dbCacheSize` (the name every doc, log line
 * and MCP call uses) finds its row though the screen labels it "Cache Size".
 *
 * Two deliberate limits:
 *
 * - **Not an index of panels.** `SettingsIndexEntry` has a `panel` kind, but the command registry
 *   already makes a command per panel from the same registry; indexing them here would list every
 *   settings screen twice, as two rows doing one thing.
 * - **Not its own matcher.** Which rows are settings results comes from `searchSettings`, the
 *   sidebar's ranking, since matching settings differently from the sidebar would be two answers to
 *   one question. Their order does not: `ranking.ts` re-sorts every section by its own score, so
 *   the palette may order them unlike the sidebar, deliberately, since it scores every kind by one
 *   measure while the sidebar ranks settings among themselves.
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
 * Reveal one settings entry through the shared `revealSetting`, the call the sidebar's own result
 * rows, the registry's section commands and the curl-paste ledger's pointers make.
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
			// The engine key is in the row because docs, logs and MCP calls name the setting by it;
			// an app setting has no such name, so its subtitle is just its panel.
			subtitle:
				entry.kind === "engine"
					? `${entry.categoryLabel} · ${entry.id}`
					: entry.categoryLabel,
			// What someone types to reach this row: the engine key docs and logs use, and its
			// aliases. Not the description: nothing filters these rows twice (`ranking.ts`), so
			// only search terms belong here.
			keywords: [entry.id, ...entry.keywords],
			perform: () => reveal(entry),
		}));

		// Only when there is more: an escape row over an exhausted result set sends the user to a
		// surface showing them the same rows again.
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
					useLayoutStore.getState().revealDrawerView("settings");
					useTabsStore.getState().openTab({ type: "settings", entityId: null });
				},
			});
		}

		return items;
	}, [index, needle]);
}
