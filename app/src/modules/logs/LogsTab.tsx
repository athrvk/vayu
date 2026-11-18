/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bottom panel's Logs tab (#3635).
 *
 * `BottomPanel` mounts it inside the tab's content box, which is a flex child
 * that fills the panel below the tab strip and clips (`min-h-0 overflow-hidden`),
 * so the tab scrolls its own list. It takes no props and reads what it needs
 * from stores and the preload bridge.
 *
 * Mounted only while the panel is open on this tab: the panel renders nothing
 * when it is closed and Radix drops an inactive tab's content, so this
 * component's mount and unmount are exactly "the tab is showing" and "the tab
 * is hidden or the panel closed", which is when a tail (`logs:tail`) must
 * start and stop.
 */

import { EmptyState } from "@/components/shared";

export function LogsTab() {
	return <EmptyState variant="inline" title="Nothing to show here yet" />;
}
