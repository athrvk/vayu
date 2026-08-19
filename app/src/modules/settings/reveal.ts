/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Go to this setting" - the one definition.
 *
 * Two calls in a fixed order, and the order is load-bearing: select first, then
 * open, so the settings tab renders the asked-for panel rather than the
 * previous selection for one frame. The anchor is what `useRevealedSetting`
 * scrolls to and outlines.
 *
 * Extracted from the command palette's own copy when the curl-paste disclosure
 * ledger (issue #708) became the third caller. A hand-rolled second copy of
 * this would be a second answer to "what does a pointer to a setting do", and
 * the palette's rows and the ledger's pointers must behave identically.
 */

import { useTabsStore } from "@/stores";
import type { SettingsCategory } from "@/types";
import { useSettingsStore } from "./settings-store";

export function revealSetting(category: SettingsCategory, anchor?: string): void {
	useSettingsStore.getState().setSelectedCategory(category, anchor);
	useTabsStore.getState().openTab({ type: "settings", entityId: null });
}
