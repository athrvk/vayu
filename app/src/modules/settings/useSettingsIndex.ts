/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The settings search corpus, assembled once.
 *
 * `lib/settings-index.ts` is the pure half - it flattens catalogues and ranks
 * matches, and knows nothing about React. This is the half that says *which*
 * catalogues: the app-panel registry, the app-settings catalogue, the engine
 * category registry, and the engine entries the `/config` query holds.
 *
 * A hook rather than four imports repeated at each call site, because there are
 * now two call sites - the settings sidebar's search box and the palette's
 * settings source - and "one branch defines it, the other re-derives it inline"
 * is this codebase's most repeated wiring defect. One index, two UIs.
 */

import { useMemo } from "react";
import { useConfigQuery } from "@/queries";
import { buildSettingsIndex, type SettingsIndexEntry } from "@/lib/settings-index";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { APP_SETTINGS } from "@/modules/settings/main/app-settings";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import { ENGINE_SETTINGS_EDITED_IN_APP } from "@/modules/settings/engine-settings-edited-in-app";

/**
 * Every searchable settings entry: the seven client panels, the settings inside
 * them, and the engine entries.
 *
 * The engine half is empty until `/config` answers, and empty is the honest
 * answer while it has not - the app half is client-side and searchable
 * immediately, which is why Settings stays usable with the engine down.
 */
export function useSettingsIndex(): SettingsIndexEntry[] {
	const { data: configResponse } = useConfigQuery();

	return useMemo(
		() =>
			buildSettingsIndex({
				panels: APP_SETTINGS_PANELS,
				appSettings: APP_SETTINGS,
				engineEntries: configResponse?.entries ?? [],
				engineCategories: ENGINE_SETTINGS_CATEGORIES,
				engineEntriesEditedInApp: ENGINE_SETTINGS_EDITED_IN_APP,
			}),
		[configResponse]
	);
}
