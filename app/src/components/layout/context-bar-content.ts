/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { TabType } from "@/stores";

/**
 * Whether the context bar has anything to show for a tab of this type.
 *
 * The bar renders null off a request tab while the Dock button and Ctrl/Cmd+I
 * flipped `contextBarOpen` unconditionally, so on six of the seven tab types the
 * toggle lit up and nothing appeared - and because the open state is persisted,
 * the bar then popped out later on the next request tab. The button's pressed
 * state and the bar's own visibility now read the same predicate, which is the
 * only way the two cannot drift apart again.
 *
 * A tab type is enough to decide this: a request tab always has a variables
 * section, even when it resolves to none ("No variables in scope" is content).
 */
export function contextBarHasContent(tabType: TabType | undefined): boolean {
	return tabType === "request";
}
