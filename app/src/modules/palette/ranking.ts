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

/** The heading over the rows the user touched most recently. */
export const RECENTS_LABEL = "Recents";

/**
 * The heading over the verbs the palette offers: on an empty query, and again
 * when a typed query matched nothing.
 */
export const QUICK_ACTIONS_LABEL = "Quick actions";

/**
 * How many rows Recents holds.
 *
 * The section's whole job is to answer "what was I just doing" before the user
 * reaches for the wheel, and six is a glance. It stays six now that the list is
 * taller (#1177): the extra height went to the sections *under* Recents, which
 * were the ones nobody could see, and a longer list of recents would take it
 * straight back.
 */
export const RECENT_LIMIT = 6;

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
	/**
	 * The most recent rows across every kind, newest first. Empty query only:
	 * once something is typed, what matches has to beat what is merely recent.
	 */
	recents: PaletteItem[];
	/**
	 * The verbs the palette offers: at the head of the empty query, and again
	 * when a typed query matched nothing at all. In between - a query with
	 * results - they rank as the `command` section they have always been.
	 */
	quickActions: PaletteItem[];
	/** The familiar fixed order, minus whatever was promoted or lifted. */
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
 *
 * The empty query answers that question with two sections of its own, above the
 * fixed order: Recents, and the verbs. Both are *lifted* out of the sections
 * their rows belong to rather than copied into the new ones - the same rule the
 * top result follows, and for the same reason: two rows carrying the same cmdk
 * `value` would both read as selected.
 */
export function rankPalette(items: PaletteItem[], query: string): RankedPalette {
	const needle = query.trim();
	if (needle === "") {
		const quickActions = verbsOf(items);
		const recents = recentsOf(items);
		const lifted = new Set([...quickActions, ...recents].map((item) => item.id));
		const groups = groupsOf(
			items.filter((item) => !lifted.has(item.id)),
			(ofKind) => rankForEmptyQuery(ofKind)
		);
		return {
			top: [],
			recents,
			quickActions,
			groups,
			total: countItems(groups) + recents.length + quickActions.length,
		};
	}

	const scores = new Map<string, number>();
	const kept: PaletteItem[] = [];
	for (const item of items) {
		const score = scoreItem(item, needle);
		scores.set(item.id, score);
		if (survives(item, score)) kept.push(item);
	}

	const promoted = bestMatch(kept, scores);
	const rest = promoted ? kept.filter((item) => item.id !== promoted.id) : kept;
	/*
	 * Within a section, score decides and the source's own order is the stable
	 * tiebreak - `Array.prototype.sort` is specified as stable, so rows that
	 * score alike keep the order their source produced (recency for runs,
	 * `searchSettings`' rank for settings, scope order for variables).
	 *
	 * A `preMatched` row is sorted on what it *prints*, which can be nothing:
	 * a run the engine matched on snapshot text sinks below one whose URL says
	 * what was typed, and among equals stays newest-first. That is a change for
	 * runs alone, and a deliberate one - their old order came of stuffing the
	 * query into every row's keywords, which scored them all alike.
	 */
	const byScore = (ofKind: PaletteItem[]) =>
		[...ofKind].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
	const groups = groupsOf(rest, byScore);
	const total = countItems(groups) + (promoted ? 1 : 0);

	/*
	 * Nothing matched, so the palette offers what it can still do rather than
	 * one dead-end line (#1177). The verbs come back as *suggestions*, not
	 * results: `total` stays 0, which is what the announcement counts and what
	 * tells the list to say that nothing matched. Whatever survives in `groups`
	 * at this point is escape rows - a row that is navigation rather than a
	 * result is why the count can be zero with rows on screen - and no verb can
	 * be among them, since none of them cleared the floor.
	 */
	if (total === 0) {
		return { top: [], recents: [], quickActions: verbsOf(items), groups, total };
	}

	return {
		top: promoted ? [promoted] : [],
		recents: [],
		quickActions: [],
		groups,
		total,
	};
}

/** The commands the palette offers as verbs - every command row that is not an escape. */
function verbsOf(items: PaletteItem[]): PaletteItem[] {
	return items.filter((item) => item.kind === "command" && !item.escape);
}

/**
 * The rows the user touched most recently, newest first, across every kind.
 *
 * Built from `recencyAt` alone, which every source that knows one already
 * stamps - so this needs no store of its own and cannot disagree with the
 * within-section order that reads the same field. A row that knows no time is
 * not recent, it is merely undated, and belongs in its own section.
 *
 * In practice that is open tabs and requests that have been sent: the deep
 * sources contribute nothing to an empty query at all, so a past run reaches
 * Recents only once something is typed - and then it is a search result rather
 * than a recent, which is the distinction the empty query is drawing.
 *
 * How far back it reaches follows the data. Tab focus times are session-scoped
 * by `tabs-store`'s documented design, so after a restart Recents is the
 * requests the run history remembers, and fills with tabs again as they are
 * used. Persisting focus time to lengthen this list would rank a restored strip
 * by yesterday's attention, which is the thing that rationale refuses.
 */
function recentsOf(items: PaletteItem[]): PaletteItem[] {
	const dated = items.filter((item) => item.recencyAt !== undefined && !item.escape);
	return rankForEmptyQuery(dated).slice(0, RECENT_LIMIT);
}

/**
 * Whether a row renders at all.
 *
 * A deep source took the query and matched it itself, against a corpus this
 * scorer cannot see - the engine matched a run on stored snapshot text that no
 * row prints. Its rows are matches by the time they arrive; the score only
 * decides where among them they sit. An escape row is not a result at all, so
 * no floor applies to it either.
 */
function survives(item: PaletteItem, score: number): boolean {
	return item.escape === true || item.preMatched === true || score >= MATCH_FLOOR;
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
