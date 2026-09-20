/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { shallow } from "zustand/shallow";
import type { TabItemProps } from "./TabItem";

/**
 * `TabItem`'s `memo` comparator, in its own module rather than exported
 * alongside the component: `TabItem.tsx` exporting a plain function next to
 * its components trips `react-refresh/only-export-components`, and this is
 * also what lets `TabStrip.render-count.test.tsx` build its own counting
 * `memo` with the exact same comparator via a plain import, no `vi.mock`
 * needed for this half.
 *
 * `descriptor` is rebuilt fresh by `useTabDescriptors` on every TabStrip
 * render regardless of whether this tab's own content changed, so reference
 * equality on it would defeat the memo below on every store write. `shallow`
 * (zustand's generic one-level comparator, not `useShallow` - there is no
 * hook here) compares its fields instead, which is what actually decides
 * whether this tab has anything new to draw (#1714).
 */
export function tabItemPropsEqual(prev: TabItemProps, next: TabItemProps): boolean {
	return (
		prev.tab === next.tab &&
		prev.isActive === next.isActive &&
		prev.width === next.width &&
		shallow(prev.descriptor, next.descriptor)
	);
}
