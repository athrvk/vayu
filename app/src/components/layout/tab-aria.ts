/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The tab -> panel relationship, as ids both ends agree on. The WAI-ARIA tabs pattern is two links:
 * the tab points at the panel with `aria-controls`, the panel names its tab with `aria-labelledby`.
 * `TabStrip` draws the tabs and `Shell` owns the content region, so the ids derive from the tab id
 * here rather than being spelled in both places, where they would drift at the first rename. A
 * sibling module, not an export from `TabStrip.tsx`, as `tab-descriptors.ts` is: a function beside
 * that file's components costs it fast refresh.
 */

/** The id of a tab element in the strip. */
export function tabElementId(tabId: string): string {
	return `tab-${tabId}`;
}

/** The id of the panel a tab controls. Only the active tab's panel is rendered. */
export function tabPanelElementId(tabId: string): string {
	return `tabpanel-${tabId}`;
}
