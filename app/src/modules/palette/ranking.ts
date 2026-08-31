/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The palette's one ranking authority.
 *
 * Everything the list shows, in the order it shows it, is decided here and
 * nowhere else. That is the point of the file: the palette used to run two
 * matchers over the same rows - each deep source pre-selected with a ranking of
 * its own, then cmdk re-scored every rendered row behind their backs - and
 * neither was in charge. A 0.99 Settings hit sat below 0.01 request noise
 * because the sections rendered in a fixed order that no score could cross.
 *
 * The scorer itself is unchanged and deliberately not ours: `defaultFilter` is
 * the `commandScore` cmdk filters with, and it already ranks correctly. What
 * changed is that it now runs once, here, where the result can also decide the
 * top result, the floor and the announced count - so the palette declares
 * `shouldFilter={false}` and cmdk scores nothing a second time. It is the same
 * arrangement `suggestion-list.tsx` and `variable-autocomplete.tsx` already use,
 * for the same reason: the caller knows something about matching that cmdk's
 * default cannot.
 */

import { defaultFilter } from "cmdk";
import { PALETTE_GROUPS, rankForEmptyQuery, type PaletteItem, type PaletteKind } from "./types";

/**
 * The score a row must reach to be a match at all.
 *
 * `commandScore` pays 0.17 for a `SCORE_CHARACTER_JUMP` - a run of characters
 * that begins in the middle of a word, which is what "oken" finding "Issue
 * token" is. A floor just under that keeps every such match and drops anything
 * that needed two or more scattered jumps to reach the query, which is the
 * shape of every noise row in the report: "theme" matched requests at
 * 0.0008-0.0975 by finding a t, an h, an e, an m and an e in different places.
 *
 * The threshold is expressed against the scorer's own constant rather than
 * tuned by eye: raise it past 0.17 and genuine mid-word matches start
 * disappearing, which is a worse bug than the one it fixes.
 */
export const MATCH_FLOOR = 0.1;

/** The heading over the promoted best match. */
export const TOP_RESULT_LABEL = "Top result";

/**
 * What a row is matched against: what it reads as, plus its extra terms.
 *
 * The id is deliberately absent - it is a uuid, and a query of "b7" would
 * otherwise match rows at random.
 */
function matchText(item: PaletteItem): string {
	return [item.title, item.subtitle].filter(Boolean).join(" ");
}

/**
 * How well a row matches, from 0 (not at all) to 1.
 *
 * Two corpora, because they want different matchers. `keywords` are short terms
 * a person types on purpose, so they go through the fuzzy scorer with the title.
 * `substringKeywords` are text the fuzzy scorer is simply wrong about - a URL is
 * the case it exists for - so they are matched literally and scored as the
 * mid-word match they are.
 */
export function scoreItem(item: PaletteItem, query: string): number {
	const fuzzy = defaultFilter(matchText(item), query, item.keywords);
	if (fuzzy >= MATCH_FLOOR) return fuzzy;
	return substringScore(item, query);
}

/**
 * A literal hit in `substringKeywords`, scored as a mid-word match.
 *
 * Scored rather than merely allowed through so a row found only by its URL
 * cannot outrank one whose name actually says what the user typed.
 */
function substringScore(item: PaletteItem, query: string): number {
	if (!item.substringKeywords?.length) return 0;
	const needle = query.toLowerCase();
	const hit = item.substringKeywords.some((term) => term.toLowerCase().includes(needle));
	return hit ? SUBSTRING_SCORE : 0;
}

/**
 * Just above the floor: a URL hit is a real match and must survive, but it is
 * the weakest kind of one - the text it matched is not even on the row.
 */
const SUBSTRING_SCORE = 0.15;

/** One rendered section: a heading, its rows, and any escape row below them. */
export interface RankedGroup {
	kind: PaletteKind;
	items: PaletteItem[];
	escapes: PaletteItem[];
}

export interface RankedPalette {
	/** The promoted best match, or empty - never more than one row. */
	top: PaletteItem[];
	/** The familiar fixed order, minus whatever was promoted. */
	groups: RankedGroup[];
	/**
	 * How many result rows render. Escape rows are navigation, not results, and
	 * are not counted - the announcement answers "did what I typed narrow
	 * anything", and an escape row is present either way.
	 */
	total: number;
}

/**
 * Everything the palette renders, ranked.
 *
 * The empty query is a different question from a typed one and gets a different
 * answer: "what was I just doing", ordered by recency, with no top result to
 * promote because nothing has been asked for yet. Once something is typed the
 * score decides - a result that matches better has to win over one that is
 * merely more recent, or typing stops feeling like searching.
 */
export function rankPalette(items: PaletteItem[], query: string): RankedPalette {
	const needle = query.trim();
	if (needle === "") {
		const groups = groupsOf(items, (ofKind) => rankForEmptyQuery(ofKind));
		return { top: [], groups, total: countItems(groups) };
	}

	const scores = new Map<string, number>();
	const kept = items.filter((item) => {
		const score = scoreItem(item, needle);
		scores.set(item.id, score);
		// A deep source took the query and matched it itself, against a corpus
		// this scorer cannot see - the engine matched a run on stored snapshot
		// text that no row prints. Its rows are matches by the time they arrive;
		// the score only decides where among them they sit. An escape row is not
		// a result at all, so no floor applies to it either.
		return item.escape || item.preMatched === true || score >= MATCH_FLOOR;
	});

	const promoted = bestMatch(kept, scores);
	const rest = promoted ? kept.filter((item) => item.id !== promoted.id) : kept;
	const byScore = (ofKind: PaletteItem[]) =>
		[...ofKind].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
	const groups = groupsOf(rest, byScore);

	return {
		top: promoted ? [promoted] : [],
		groups,
		total: countItems(groups) + (promoted ? 1 : 0),
	};
}

/** Where each kind sits on screen, for breaking a tie the way the eye would. */
const GROUP_ORDER = new Map<PaletteKind, number>(
	PALETTE_GROUPS.map((kind, index) => [kind, index])
);

/**
 * The row to promote: the best-scoring result, or none.
 *
 * A row that only cleared the floor because its source vouched for it has
 * nothing on screen matching what was typed, so it is not a "top result" -
 * hence the floor here as well as in the filter above. Ties go to the earlier
 * section, so the promotion follows the order on screen rather than the order
 * the sources happened to be concatenated in.
 */
function bestMatch(items: PaletteItem[], scores: Map<string, number>): PaletteItem | undefined {
	let best: PaletteItem | undefined;
	for (const item of items) {
		if (item.escape) continue;
		const score = scores.get(item.id) ?? 0;
		if (score < MATCH_FLOOR) continue;
		if (best && !outranks(item, score, best, scores)) continue;
		best = item;
	}
	return best;
}

function outranks(
	item: PaletteItem,
	score: number,
	best: PaletteItem,
	scores: Map<string, number>
): boolean {
	const bestScore = scores.get(best.id) ?? 0;
	if (score !== bestScore) return score > bestScore;
	return (GROUP_ORDER.get(item.kind) ?? 0) < (GROUP_ORDER.get(best.kind) ?? 0);
}

/** The fixed section order, with each section's rows ordered by `order`. */
function groupsOf(
	items: PaletteItem[],
	order: (ofKind: PaletteItem[]) => PaletteItem[]
): RankedGroup[] {
	return PALETTE_GROUPS.map((kind) => {
		const ofKind = items.filter((item) => item.kind === kind);
		return {
			kind,
			items: order(ofKind.filter((item) => !item.escape)),
			escapes: ofKind.filter((item) => item.escape),
		};
	}).filter((group) => group.items.length > 0 || group.escapes.length > 0);
}

function countItems(groups: RankedGroup[]): number {
	return groups.reduce((n, group) => n + group.items.length, 0);
}
