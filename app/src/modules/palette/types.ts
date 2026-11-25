/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One row in the command palette, whatever produced it. Every source returns this shape, so the
 * dialog renders and ranks a result without knowing where it came from, and a new source needs no
 * change to the dialog.
 */

import type { LucideIcon } from "lucide-react";
import type { Chord } from "@/lib/platform";

/** Result groups, in their fixed screen order, so the list does not reshuffle as you type. */
export const PALETTE_GROUPS = [
	"tab",
	"request",
	"collection",
	"view",
	"command",
	"settings",
	"variable",
	"run",
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
	variable: "Variables",
	run: "Runs",
};

/**
 * How many rows a deep-search group shows before its escape row. The deep sources index corpora the
 * shallow ones lack (~65 settings entries, every variable key in every scope, an unbounded run
 * archive); uncapped, one would own the list for any broad query, so each shows its best few and
 * offers a row into the surface built for browsing the rest.
 */
export const DEEP_GROUP_LIMIT = 7;

export interface PaletteItem {
	/** Unique across all sources - used as the React key. */
	id: string;
	kind: PaletteKind;
	/** What the row reads as. Matched against the query. */
	title: string;
	/** Where it lives - a collection path, a tab's kind. Also matched. */
	subtitle?: string;
	/**
	 * Extra terms that should find this row but do not belong on screen: short terms typed on
	 * purpose (a method, a scope, an alias), matched fuzzily with the title. Anything long or
	 * punctuated (a URL, a description sentence) belongs in `substringKeywords`.
	 */
	keywords?: string[];
	/**
	 * Terms matched as a literal substring, not fuzzily.
	 *
	 * A URL is the case this exists for: `commandScore` is a subsequence matcher, and to it any
	 * path is character soup ("theme" scores 0.51 against `/the/most/expensive/endpoint` by finding
	 * five letters in five places). Nobody fuzzy-searches a URL; they type a piece of one. A
	 * settings section's description is the other case (#3322): a sentence the settings sidebar
	 * finds by a phrase, so the palette matches it as one entry rather than as words in `keywords`.
	 *
	 * The cost: the piece must be contiguous, so `v1/charges` finds the row and `v1charges` does
	 * not. No floor could buy that back: a URL is all separators, so the scorer reads a query
	 * scattered across its segments as a series of word jumps, which is what scored the soup 0.51.
	 * A query that skips a separator is indistinguishable from one that matches nothing.
	 */
	substringKeywords?: string[];
	icon?: LucideIcon;
	/** HTTP method, drawn as the same colour rail the tab strip uses. */
	method?: string;
	/**
	 * The chord that already runs this row, drawn as key caps on its trailing
	 * edge. Carried from the command registry, which holds the one definition
	 * the handler also reads (#938) - never matched against, only printed.
	 */
	shortcut?: Chord;
	/**
	 * When this last mattered to the user, in epoch ms; `undefined` when
	 * nothing knows. Orders the empty query - see `rankForEmptyQuery`.
	 */
	recencyAt?: number;
	/**
	 * The entity this row opens, as `request:<id>`, when two rows can open it (a request's own row
	 * and its open tab's). Read only by `recentsOf`, which lists such an entity once.
	 */
	entityKey?: string;
	/**
	 * Set by a deep source: matched against text the palette's scorer cannot see (a settings
	 * description no row prints, a run's stored snapshot), so no relevance floor applies; a second
	 * opinion formed from less evidence would throw that work away.
	 *
	 * A property of the row, not of its `kind`: the command registry contributes `settings` rows
	 * too (one per panel), and those are shallow rows that must clear the floor like any other.
	 */
	preMatched?: boolean;
	/**
	 * A "search the rest of these over there" row, not a result: it leaves the palette for the
	 * surface that browses this corpus, carrying the query. Rendered in a group of its own below
	 * its results, which is why the flag exists; `ranking.ts` neither scores it, promotes it, nor
	 * counts it in the announced total.
	 */
	escape?: boolean;
	/** What Enter (or a click) does. The palette closes itself afterwards. */
	perform: () => void;
}

/**
 * Order for the empty query only: most recent first, then the source's own order
 * (`Array.prototype.sort` is stable, so undated items keep it: strip order for tabs, tree order for
 * requests). Once something is typed the match score decides (`ranking.ts`): a better match must
 * beat a more recent one, or typing stops feeling like searching.
 */
export function rankForEmptyQuery(items: PaletteItem[]): PaletteItem[] {
	return [...items].sort((a, b) => (b.recencyAt ?? 0) - (a.recencyAt ?? 0));
}
