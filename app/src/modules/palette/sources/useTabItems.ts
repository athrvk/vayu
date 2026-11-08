/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Open tabs, as palette results.
 *
 * The cheapest win in the palette: with a dozen tabs open the strip has already
 * pushed half of them into the overflow menu, and this reaches any of them by
 * name.
 *
 * Labels come from `tab-descriptors`, the same hook the strip itself uses - a
 * tab must not read "GET /v1/orders" in one place and "Request" in the other.
 */

import { useTabsStore } from "@/stores";
import { useTabDescriptors } from "@/components/layout/tab-descriptors";
import type { PaletteItem } from "../types";

export function useTabItems(): PaletteItem[] {
	const openTabs = useTabsStore((s) => s.openTabs);
	const focusTab = useTabsStore((s) => s.focusTab);
	const tabFocusedAt = useTabsStore((s) => s.tabFocusedAt);
	const descriptors = useTabDescriptors(openTabs);

	return openTabs.map((tab, i) => {
		const d = descriptors[i];
		return {
			id: `tab:${tab.id}`,
			kind: "tab" as const,
			title: d.label,
			// A request tab's `path` ("Users / Get user") is the disambiguator two
			// same-named tabs need; its `title` ("GET Get user") repeats the name.
			// Tabs with no path keep the strip's tooltip ("Send: POST /login").
			subtitle: d.path ?? (d.title === d.label ? undefined : d.title),
			keywords: [tab.type],
			...(d.icon ? { icon: d.icon } : {}),
			...(d.method ? { method: d.method } : {}),
			...(tabFocusedAt[tab.id] !== undefined ? { recencyAt: tabFocusedAt[tab.id] } : {}),
			perform: () => focusTab(tab.id),
		};
	});
}
