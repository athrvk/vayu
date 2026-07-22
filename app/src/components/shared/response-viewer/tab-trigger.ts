/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The underline-on-active look shared by every response tab.
 *
 * This exact string was written out ten times across `ResponseViewer` (seven)
 * and `UnifiedResponseViewer`'s now-deleted full mode (three), which was ten
 * chances for one of them to lose the `data-[state=active]` half and stop
 * showing which tab is selected. `UnifiedResponseViewer` is compact-only now
 * and renders plain `Button`s instead of `Tabs`, so it no longer uses this
 * constant - `ResponseViewer` is the sole consumer.
 *
 * `shrink-0` is not included here: the request builder needs it, because its
 * seven tabs scroll horizontally in a narrow pane, and adds it via `cn()`.
 */
export const RESPONSE_TAB_TRIGGER =
	"border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent";
