/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The palette's one ranking authority: everything the list shows, and its order, is decided here
 * and nowhere else. Two matchers over the same rows (a deep source's own ranking, then cmdk
 * re-scoring every rendered row) leave neither in charge: a 0.99 Settings hit sat below 0.01
 * request noise because the fixed section order beat any score.
 *
 * The scorer is deliberately not ours: `defaultFilter` is the `commandScore` cmdk filters with, and
 * it ranks correctly. It runs once, here, where the result also decides the top result, the floor
 * and the announced count, so the palette declares `shouldFilter={false}`. `suggestion-list.tsx`
 * and `variable-autocomplete.tsx` do the same, for the same reason: the caller knows something
 * about matching that cmdk's default cannot.
 */

import { defaultFilter } from "cmdk";
import { PALETTE_GROUPS, rankForEmptyQuery, type PaletteItem, type PaletteKind } from "./types";

/**
 * The score a row must reach to match at all.
 *
 * `commandScore` pays 0.17 for a `SCORE_CHARACTER_JUMP`, a run that starts mid-word ("oken" finding
 * "Issue token"). A floor just under that keeps every such match and drops anything that needed two
 * or more scattered jumps, the shape of every noise row reported: "theme" matched requests at
 * 0.0008-0.0975 by finding a t, an h, an e, an m and an e in different places. Set against the
 * scorer's constant, not by eye: past 0.17 genuine mid-word matches disappear, a worse bug than the
 * one it fixes.
 */
export const MATCH_FLOOR = 0.1;

/** The heading over the promoted best match. */
export const TOP_RESULT_LABEL = "Top result";

/** The heading over the rows the user touched most recently. */
export const RECENTS_LABEL = "Recents";

/** The heading over the verbs: on an empty query, and when a typed query matched nothing. */
export const QUICK_ACTIONS_LABEL = "Quick actions";

/**
 * How many rows Recents holds: it answers "what was I just doing" at a glance. Six, though the list
 * is taller (#1177): the extra height is for the sections under Recents, and a longer Recents would
 * take it back.
 */
export const RECENT_LIMIT = 6;

/**
 * How many rows an unbounded group renders before it says how many it left out.
 *
 * Requests and collections grow with the workspace (deep sources cap themselves at
 * `DEEP_GROUP_LIMIT`; tabs, views and commands are bounded by the app), and one cmdk row per
 * request is a render cost that scales with the data and repeats per keystroke (#2545). The cap
 * applies after ordering, so the best match is always inside it: ranking sees the whole set and
 * only the DOM is limited. No growing window: the palette is a search box, so row 51 is reached by
 * a longer query, and the "N more" line says how many exist.
 */
export const PALETTE_GROUP_RENDER_LIMIT = 50;

/** The kinds that grow with the workspace, and so the ones `PALETTE_GROUP_RENDER_LIMIT` caps. */
const RENDER_CAPPED_KINDS: ReadonlySet<PaletteKind> = new Set<PaletteKind>([
	"request",
	"collection",
]);

/**
 * What a row is matched against: what it reads as, plus its extra terms. Not the id: a uuid, so a
 * query of "b7" would match rows at random.
 */
function matchText(item: PaletteItem): string {
	return [item.title, item.subtitle].filter(Boolean).join(" ");
}

/**
 * How well a row matches, from 0 (not at all) to 1. `keywords` are short terms typed on purpose, so
 * they go through the fuzzy scorer with the title; `substringKeywords` are text the fuzzy scorer is
 * wrong about (a URL), so they are matched literally and scored as the mid-word match they are.
 */
export function scoreItem(item: PaletteItem, query: string): number {
	const fuzzy = defaultFilter(matchText(item), query, item.keywords);
	if (fuzzy >= MATCH_FLOOR) return fuzzy;
	return substringScore(item, query);
}

/**
 * A literal hit in `substringKeywords`, scored as a mid-word match so a row found only by its URL
 * cannot outrank one whose name says what was typed.
 */
function substringScore(item: PaletteItem, query: string): number {
	if (!item.substringKeywords?.length) return 0;
	const needle = query.toLowerCase();
	const hit = item.substringKeywords.some((term) => term.toLowerCase().includes(needle));
	return hit ? SUBSTRING_SCORE : 0;
}

/** Just above the floor: a real match, but the weakest kind; the matched URL is not on the row. */
const SUBSTRING_SCORE = 0.15;

/** One rendered section: a heading, its rows, and any escape row below them. */
export interface RankedGroup {
	kind: PaletteKind;
	/** The rows that render: at most `PALETTE_GROUP_RENDER_LIMIT` for a workspace-sized kind. */
	items: PaletteItem[];
	/** Rows ranked into this group and left off the screen by the cap. */
	hidden: number;
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
	 * The verbs: at the head of the empty query, and again when a typed query matched nothing; with
	 * results they rank as the ordinary `command` section. On the empty query, minus any verb
	 * Recents holds: that row renders there, one section up.
	 */
	quickActions: PaletteItem[];
	/** The familiar fixed order, minus whatever was promoted or lifted. */
	groups: RankedGroup[];
	/**
	 * How many result rows matched, hidden ones included; not escape rows, which are present either
	 * way, so counting them would not say whether the query narrowed anything.
	 */
	total: number;
}

/**
 * Everything the palette renders, ranked.
 *
 * The empty query is a different question ("what was I just doing"): ordered by recency, with no
 * top result, since nothing has been asked. Once something is typed the score decides: a better
 * match beats a more recent one, or typing stops feeling like searching.
 *
 * The empty query gets two sections of its own above the fixed order, Recents and the verbs. Both
 * are lifted out of their rows' sections, and out of each other, rather than copied, the rule the
 * top result follows: two rows with one cmdk `value` would both read as selected.
 */
export function rankPalette(items: PaletteItem[], query: string): RankedPalette {
	const needle = query.trim();
	if (needle === "") {
		/*
		 * The lead sections render in build order and the earlier one owns a row, the precedence
		 * the top result sets. The predicates are independent (a verb is a `command` row, a recent
		 * carries `recencyAt`), so without the exclusion one added stamp would put a row under both
		 * headings: two rows with one cmdk `value`, selected together, counted twice in `total`. No
		 * source stamps a command today, so no screen changes; this keeps the first one that does
		 * from arming the defect silently.
		 */
		const recents = recentsOf(items);
		const recentIds = new Set(recents.map((item) => item.id));
		const quickActions = verbsOf(items).filter((item) => !recentIds.has(item.id));
		const lifted = new Set([...recents, ...quickActions].map((item) => item.id));
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
	 * Within a section the score decides, and the source's order is the stable tiebreak
	 * (`Array.prototype.sort` is stable): recency for runs, `searchSettings`' rank for settings,
	 * scope order for variables.
	 *
	 * A `preMatched` row is sorted on what it prints, which can be nothing: a run the engine
	 * matched on snapshot text sinks below one whose URL says what was typed, and among equals
	 * stays newest-first. Deliberate: putting the query in every run's keywords would score them
	 * all alike.
	 */
	const byScore = (ofKind: PaletteItem[]) =>
		[...ofKind].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
	const groups = groupsOf(rest, byScore);
	const total = countItems(groups) + (promoted ? 1 : 0);

	/*
	 * Nothing matched, so the palette offers what it can still do rather than one dead-end line
	 * (#1177). The verbs come back as suggestions, not results: `total` stays 0, which the
	 * announcement counts and which tells the list to say nothing matched. What is left in `groups`
	 * here is escape rows (navigation, which is how the count is zero with rows on screen), and no
	 * verb is among them, since none cleared the floor.
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
 * Built from `recencyAt` alone, which every source that knows one stamps, so it needs no store of
 * its own and cannot disagree with the within-section order that reads the same field. A row with
 * no time is undated, not recent.
 *
 * In practice that is open tabs and sent requests: the deep sources contribute nothing to an empty
 * query, so a past run reaches Recents only once something is typed, and then as a search result
 * rather than a recent.
 *
 * A request both sent and open is two dated rows (its own and its tab's) for one activity and would
 * spend two `RECENT_LIMIT` slots. The tab row stays (it focuses what is open); the request row
 * leaves Recents only and keeps its place in Requests, since it is not lifted.
 *
 * How far back it reaches follows the data. Tab focus times are session-scoped by `tabs-store`'s
 * design, so after a restart Recents is the requests the run history remembers, refilling with tabs
 * as they are used. Persisting focus time would rank a restored strip by yesterday's attention,
 * which that design refuses.
 */
function recentsOf(items: PaletteItem[]): PaletteItem[] {
	const dated = items.filter((item) => item.recencyAt !== undefined && !item.escape);
	const openEntities = new Set(
		dated.flatMap((item) => (item.kind === "tab" && item.entityKey ? [item.entityKey] : []))
	);
	const distinct = dated.filter(
		(item) => !(item.kind === "request" && item.entityKey && openEntities.has(item.entityKey))
	);
	return rankForEmptyQuery(distinct).slice(0, RECENT_LIMIT);
}

/**
 * Whether a row renders at all. A deep source's rows were matched against a corpus this scorer
 * cannot see (the engine matched a run on stored snapshot text no row prints), so they are matches
 * on arrival and the score only orders them. An escape row is not a result, so no floor applies to
 * it either.
 */
function survives(item: PaletteItem, score: number): boolean {
	return item.escape === true || item.preMatched === true || score >= MATCH_FLOOR;
}

/** Where each kind sits on screen, for breaking a tie the way the eye would. */
const GROUP_ORDER = new Map<PaletteKind, number>(
	PALETTE_GROUPS.map((kind, index) => [kind, index])
);

/**
 * The row to promote: the best-scoring result, or none. A row that cleared the floor only on its
 * source's word has nothing on screen matching the query, so it is no "top result": hence the floor
 * here too. Ties go to the earlier section, so promotion follows screen order, not the order the
 * sources were concatenated in.
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
		const ordered = order(ofKind.filter((item) => !item.escape));
		const shown = RENDER_CAPPED_KINDS.has(kind)
			? ordered.slice(0, PALETTE_GROUP_RENDER_LIMIT)
			: ordered;
		return {
			kind,
			items: shown,
			hidden: ordered.length - shown.length,
			escapes: ofKind.filter((item) => item.escape),
		};
	}).filter((group) => group.items.length > 0 || group.escapes.length > 0);
}

function countItems(groups: RankedGroup[]): number {
	return groups.reduce((n, group) => n + group.items.length + group.hidden, 0);
}
