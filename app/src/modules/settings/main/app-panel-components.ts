/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which component renders each app settings category.
 *
 * The other half of `app-panels.ts`, split from it so that the panels load with
 * the settings surface rather than at startup (#1146): the registry beside this
 * is read by the Drawer's category tree and the command palette's registry,
 * both alive on every tab, and a `Component` field there dragged all eight
 * panels into the entry chunk no matter what `Shell` did with `SettingsMain`.
 *
 * A `Record` keyed by `ClientSettingsCategory` rather than a second list: a
 * category added to the registry without a panel here does not compile, which
 * is the drift a split like this would otherwise invite.
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

export const APP_PANEL_COMPONENTS: Record<ClientSettingsCategory, ComponentType> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	editor: EditorPanel,
	dashboard: DashboardPanel,
	"load-testing": LoadTestingPanel,
	notifications: NotificationsPanel,
	shortcuts: KeyboardShortcutsPanel,
	mcp: McpSettingsPanel,
};
