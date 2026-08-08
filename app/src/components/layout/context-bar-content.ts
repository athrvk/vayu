/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Tab } from "@/stores";
import { sectionsForTab } from "./context-bar/registry";

/**
 * Whether the context bar has anything to show for this tab.
 *
 * The bar renders null where it has no sections while the Dock button and
 * Ctrl/Cmd+I flipped `contextBarOpen` unconditionally, so on six of the seven
 * tab types the toggle lit up and nothing appeared - and because the open state
 * is persisted, the bar then popped out later on the next request tab. The
 * button's pressed state and the bar's own visibility read the same predicate,
 * which is the only way the two cannot drift apart again.
 *
 * That predicate is now the section registry rather than a hardcoded tab type:
 * adding a Phase 2 collection section makes the toggle live on collection tabs
 * by itself, and there is no second place to remember to update. It takes the
 * whole tab because a section's `appliesTo` may look past the type.
 */
export function contextBarHasContent(tab: Tab | undefined): boolean {
	return sectionsForTab(tab).length > 0;
}
