/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Tab } from "@/stores";
import { sectionsForTab } from "./context-bar/registry";

/**
 * Whether the context bar has anything to show for this tab. The bar, the context rail and
 * `useOverlayPanel` all read it, so no control offers the bar on a tab where it draws nothing; a
 * toggle that lit with nothing appearing, and a persisted open flag that then popped the bar out on
 * the next request tab, are what a second check would let back in.
 *
 * The predicate is the section registry, not a hardcoded tab type: a section that applies to
 * collection tabs makes the bar live there by itself, with no second place to update. It takes the
 * whole tab because a section's `appliesTo` may look past the type.
 */
export function contextBarHasContent(tab: Tab | undefined): boolean {
	return sectionsForTab(tab).length > 0;
}
