/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Opening Settings, and opening it on one section. Lives apart from `registry.ts`
 * so a surface that is not a palette command (the first-run welcome's
 * agent-connect row) reaches the same two calls without importing the whole
 * command roster.
 */

import { useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import type { SettingsCategory } from "@/types";

/** Open the Settings tab. The Shell's own effect brings its drawer view with it. */
export function openSettingsTab(): void {
	useTabsStore.getState().openTab({ type: "settings", entityId: null });
}

/**
 * Reveal one settings section - the same two calls the sidebar's `selectCategory`
 * makes, in the same order: select first, then open, so the tab renders the
 * asked-for panel rather than the previous selection for one frame.
 */
export function revealSettingsCategory(category: SettingsCategory): void {
	useSettingsStore.getState().setSelectedCategory(category);
	openSettingsTab();
}
