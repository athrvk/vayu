/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The underline-on-active look shared by every response tab.
 *
 * This exact string was written out ten times - seven in `ResponseViewer`,
 * three in `UnifiedResponseViewer` - which is ten chances for one of them to
 * lose the `data-[state=active]` half and stop showing which tab is selected.
 *
 * Only the string is shared. Which tabs exist, what their badges count and what
 * they render genuinely differ between the two viewers (seven tabs against
 * three, live context against stored props), so there is deliberately no
 * `tabs={[...]}` config here - that would trade a duplicated class name for a
 * component driven by flags, which is the worse of the two.
 *
 * `shrink-0` is not included: the request builder needs it, because its seven
 * tabs scroll horizontally in a narrow pane, and adds it via `cn()`. The three
 * tabs in a compact history card are better off allowed to shrink.
 */
export const RESPONSE_TAB_TRIGGER =
	"border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent";
