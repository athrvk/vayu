/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tab -> panel relationship, as ids both ends agree on.
 *
 * The WAI-ARIA tabs pattern is two links, not one: the tab points at the panel
 * with `aria-controls`, the panel names its tab with `aria-labelledby`. The two
 * ends are rendered by different components - `TabStrip` draws the tabs, `Shell`
 * owns the content region - so the ids are derived from the tab id here rather
 * than spelled out in both places, where they would drift the first time either
 * side was renamed. The strip used to declare `role="tablist"` and stop, which
 * announces "tab 2 of 3" over content that claims no owner.
 *
 * A sibling module rather than an export from `TabStrip.tsx` for the same reason
 * `tab-descriptors.ts` is one: that file exports components, and a function
 * beside them costs it fast refresh.
 */

/** The id of a tab element in the strip. */
export function tabElementId(tabId: string): string {
	return `tab-${tabId}`;
}

/** The id of the panel a tab controls. Only the active tab's panel is rendered. */
export function tabPanelElementId(tabId: string): string {
	return `tabpanel-${tabId}`;
}
