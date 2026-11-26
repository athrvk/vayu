/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which component renders each app settings category: the other half of `app-panels.ts`, split off
 * so the panels load with the settings surface rather than at startup (#1146). That registry is
 * read by the Drawer's category tree and the palette's registry, alive on every tab, and a
 * `Component` field there would drag all eight panels into the entry chunk whatever `Shell` does
 * with `SettingsMain`.
 *
 * A `Record` keyed by `ClientSettingsCategory`, not a second list: a category added to the registry
 * without a panel here does not compile, the drift such a split would otherwise invite.
 */

import type { ComponentType } from "react";
import type { ClientSettingsCategory } from "@/types";
import AppearancePanel from "./panels/AppearancePanel";
import EditorPanel from "./panels/EditorPanel";
import DashboardPanel from "./panels/DashboardPanel";
import LoadTestingPanel from "./panels/LoadTestingPanel";
import McpSettingsPanel from "./panels/McpSettingsPanel";
import NotificationsPanel from "./panels/NotificationsPanel";
import GeneralPanel from "./panels/GeneralPanel";
import KeyboardShortcutsPanel from "./panels/KeyboardShortcutsPanel";
import FilesPanel from "./panels/FilesPanel";

export const APP_PANEL_COMPONENTS: Record<ClientSettingsCategory, ComponentType> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	editor: EditorPanel,
	dashboard: DashboardPanel,
	"load-testing": LoadTestingPanel,
	notifications: NotificationsPanel,
	shortcuts: KeyboardShortcutsPanel,
	mcp: McpSettingsPanel,
	files: FilesPanel,
};
