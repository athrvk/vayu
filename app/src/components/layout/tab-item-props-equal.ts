/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { shallow } from "zustand/shallow";
import type { TabItemProps } from "./TabItem";

/**
 * `TabItem`'s `memo` comparator, in its own module: a plain function exported beside
 * `TabItem.tsx`'s components trips `react-refresh/only-export-components`, and a plain import lets
 * `TabStrip.render-count.test.tsx` build its counting `memo` with the same comparator, no `vi.mock`
 * needed for this half. `useTabDescriptors` rebuilds `descriptor` on every TabStrip render whether
 * or not this tab's content changed, so reference equality would defeat the memo on every store
 * write; `shallow` (zustand's one-level comparator, not the `useShallow` hook) compares its fields,
 * which decides whether this tab has anything new to draw (#1714).
 */
export function tabItemPropsEqual(prev: TabItemProps, next: TabItemProps): boolean {
	return (
		prev.tab === next.tab &&
		prev.isActive === next.isActive &&
		prev.isRovingStop === next.isRovingStop &&
		prev.width === next.width &&
		shallow(prev.descriptor, next.descriptor)
	);
}
