/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Engine settings whose visible editor is an app panel row.
 *
 * A few `/config` entries are edited from an app panel, because that is where their effect is on
 * screen, and the engine list must not offer a *second* editor: two editors for
 * `liveReplayWindowMs` ("Live Chart Window" staged with a Save bar in the engine view, "Chart
 * window" autosaved in App > Dashboard) are one value with two labels and two save models, staging
 * one and flipping the other leaves the staged row showing a value never saved there, and settings
 * search returns two results for one knob with nothing saying they are the same (#586).
 *
 * This map is the one place that pairing is written down, and its exactly two readers keep it
 * honest:
 *
 * - `SettingsMain` drops these keys from the engine category's list, so the panel row is the only
 *   editor.
 * - `buildSettingsIndex` folds the engine key into the panel row's search keywords instead of
 *   indexing the entry separately, so typing `liveReplayWindowMs` (the name every doc, log line and
 *   MCP call uses) still finds the setting, lands on the row that edits it, and returns *one*
 *   result.
 *
 * The entry stays seeded, on `GET /config` and writable through `POST /config` and the MCP
 * `update_config` tool; only the duplicate editor is gone. Not the same as `advanced`, which
 * collapses an entry the engine list still owns: here the engine list owns nothing.
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
