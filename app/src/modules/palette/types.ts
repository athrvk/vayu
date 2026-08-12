/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row in the command palette, whatever produced it.
 *
 * Every source returns this shape and nothing else, so the dialog knows how to
 * render and rank a result without knowing where it came from - which is what
 * lets a later phase add settings, environments and runs as sources without
 * touching the dialog.
 */

import type { LucideIcon } from "lucide-react";

/**
 * Which group a result renders under. The order here is the order on screen:
 * groups are fixed so the list does not reshuffle as you type.
 */
export const PALETTE_GROUPS = [
	"tab",
	"request",
	"collection",
	"view",
	"command",
	"settings",
] as const;

export type PaletteKind = (typeof PALETTE_GROUPS)[number];

/** Heading shown above each group. */
export const PALETTE_GROUP_LABELS: Record<PaletteKind, string> = {
	tab: "Tabs",
	request: "Requests",
	collection: "Collections",
	view: "Views",
	command: "Commands",
	// Its own group rather than more Commands: twelve sections would bury the
	// five things the palette can actually *do*.
	settings: "Settings",
};

export interface PaletteItem {
	/** Unique across all sources - used as the React key. */
	id: string;
	kind: PaletteKind;
	/** What the row reads as. Matched against the query. */
	title: string;
	/** Where it lives - a collection path, a tab's kind. Also matched. */
	subtitle?: string;
	/** Extra terms that should find this row but do not belong on screen. */
	keywords?: string[];
	icon?: LucideIcon;
	/** HTTP method, drawn as the same colour rail the tab strip uses. */
	method?: string;
	/**
	 * When this last mattered to the user, in epoch ms; `undefined` when
	 * nothing knows. Orders the empty query - see `rankForEmptyQuery`.
	 */
	recencyAt?: number;
	/** What Enter (or a click) does. The palette closes itself afterwards. */
	perform: () => void;
}

/**
 * Order for the empty query: most recent first, then the source's own order.
 *
 * Only for the empty query. Once there is something typed, cmdk's match score
 * decides - a result that matches better has to win over one that is merely
 * more recent, or typing stops feeling like searching.
 *
 * Stable: `Array.prototype.sort` is specified as stable, so items with no
 * recency at all keep the order their source produced (strip order for tabs,
 * tree order for requests).
 */
export function rankForEmptyQuery(items: PaletteItem[]): PaletteItem[] {
	return [...items].sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0));
}
