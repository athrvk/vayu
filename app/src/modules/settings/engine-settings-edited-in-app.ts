/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Engine settings whose visible editor is an app panel row
 *
 * A handful of `/config` entries are edited from an app panel, because that is
 * where their effect is on screen. The engine list must not offer a *second*
 * editor for those: `liveReplayWindowMs` used to render both as "Live Chart
 * Window" in the engine view (staged edit, Save bar) and as "Chart window" in
 * App > Dashboard (autosave option buttons) - one value, two labels, two save
 * models. Staging one and flipping the other left the staged row quietly
 * showing a value the user never saved there, and settings search returned two
 * results for one knob with nothing saying they were the same knob (#586).
 *
 * This map is the one place that pairing is written down, and it has exactly
 * two readers, which is what keeps it honest:
 *
 * - `SettingsMain` drops these keys from the engine category's list, so the
 *   panel row below is the only editor.
 * - `buildSettingsIndex` folds the engine key into the panel row's search
 *   keywords instead of indexing the entry separately - so typing
 *   `liveReplayWindowMs`, the name every doc, log line and MCP call uses, still
 *   finds the setting, lands on the row that edits it, and returns *one*
 *   result rather than two.
 *
 * The entry stays seeded, stays on `GET /config` and stays writable through
 * `POST /config` and the MCP `update_config` tool. Only the duplicate editor is
 * gone.
 *
 * This is deliberately not the same thing as `advanced`, which collapses an
 * entry the engine list still owns. Here the engine list owns nothing: another
 * surface does.
 */

import type { ClientSettingsCategory } from "@/types";

export interface AppEditorLocation {
	/** The app panel that renders the editor. */
	panel: ClientSettingsCategory;
	/** That panel's `data-setting-anchor` for the row, and the app-settings catalogue id. */
	anchor: string;
}

export const ENGINE_SETTINGS_EDITED_IN_APP: Readonly<Record<string, AppEditorLocation>> = {
	liveReplayWindowMs: { panel: "dashboard", anchor: "chart-window" },
};

/** Where an engine entry is edited, when the engine list does not edit it. */
export function appEditorFor(engineKey: string): AppEditorLocation | undefined {
	return ENGINE_SETTINGS_EDITED_IN_APP[engineKey];
}
