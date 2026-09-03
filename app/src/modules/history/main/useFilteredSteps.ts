/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The window of step rows a filter matches, kept across a live run's commits
 * (issues #1205, #1297).
 *
 * A scenario run's list grows for the length of the run and every batch hands
 * the view a new array (immutability, which zustand's change detection depends
 * on). Filtering that array per commit therefore ran the predicate over every
 * row the run had produced, every flush - and the predicate is the expensive
 * kind: a search lowercases each step's name, allocating a string per row per
 * flush. #1205 removed that pass by keeping the rows already matched and
 * testing the batch alone. What it left was the *copy*: those kept rows were
 * rebuilt as one array on every commit whose batch matched something, so a
 * flush still cost one pointer per row that had ever matched.
 *
 * A reader is never shown all of them. The list renders a growing window - 200
 * rows, more as the end scrolls into view - so what a flush has to produce is
 * bounded by that window, and only the *total* has to know about the rest.
 * This hook keeps the two separately:
 *
 * - **A count, maintained incrementally.** One pass over the rows that arrived
 *   since the last one, added to what was counted before. O(batch), and it
 *   allocates nothing: the count is what the "showing X of Y" line states and
 *   what the window is sized against.
 * - **A window, produced as far as it is needed.** The first `visible` matches
 *   never change once found, because a live list only appends after them. So
 *   the source index the window was produced through is remembered, and the
 *   scan resumes from it when the sentinel grows `visible`. Once the window is
 *   full the pass is skipped outright and the array is handed back by identity:
 *   a flush under an active filter then copies nothing at all.
 *
 * **Why this hook owns the growing window.** `visible` comes from
 * {@link useGrowingWindow}, whose total is the count this hook maintains, and
 * the window pass needs `visible` to know when to stop - so the two are one
 * ordering, not two. Kept apart they would be two caches over the same rows
 * with the same three invalidation axes (the filter, the list identity, a
 * replay) to keep in step, and nothing to fail loudly if they drifted. One
 * cache holds both, invalidated once.
 *
 * **What tells it the list only grew.** `appendKey` identifies *which* list
 * this is - the store's `appendEpoch` for the live rows, the array itself for
 * the stored ones - the same shape as `useGrowingWindow`'s `resetKey`, and for
 * the same reason. It moves whenever anything but an append happened, so a
 * replay that replaced a row, a run that restarted, or the changeover to stored
 * rows starts the matching over. The epoch is monotone, so two commits
 * coalesced into one render are still either "both appended" (what was found
 * still holds) or "the number moved" (start over). Nothing compares rows to
 * decide, which is the scan this exists to avoid.
 *
 * **What a commit still costs.** One predicate pass over the batch, always.
 * Plus, while the window is not yet full, a second pass over that same batch -
 * the count runs to the end of the list and the window pass follows it - which
 * stops for good once the first `visible` matches have been found, and resumes
 * only for the rows a grown `visible` still lacks. Nothing is rescanned twice
 * over a run's lifetime beyond that; the steady state of a long run streaming
 * past a filled window is one pass over the batch and no allocation.
 */

import { useState } from "react";
import { GROWING_WINDOW_STEP, useGrowingWindow } from "@/hooks/useGrowingWindow";
import {
	narrowsSteps,
	stepMatcher,
	type ScenarioStepRow,
	type StepListFilter,
} from "./scenario-steps";

/** Shared, so a list with nothing in it costs no allocation at all. */
const NONE: readonly ScenarioStepRow[] = [];

export interface FilteredStepWindow {
	/** How many rows matched - the total the "showing X of Y" line states. */
	total: number;
	/**
	 * The matching rows to render: the first `visible` of them, in plan order.
	 *
	 * Held across commits, so the reference is stable while the window is full
	 * and the list only grows - that identity is the copy this hook exists to
	 * avoid, and the cost tests assert it. Never mutated in place: a longer
	 * window is a new array, so what a caller holds cannot change under it.
	 */
	rows: readonly ScenarioStepRow[];
	/** Attach to an element at the end of the rendered list. */
	sentinelRef: (node: HTMLElement | null) => void;
	/** True while matching rows remain unrendered. */
	hasMore: boolean;
}

/** A window of matching rows, and how far into the source list it was read. */
interface ProducedWindow {
	/** Every match in `steps[0, produced)` - so, the first `rows.length`. */
	rows: readonly ScenarioStepRow[];
	/**
	 * The source index {@link rows} was produced through. Short of the whole
	 * list exactly when the window filled first.
	 */
	produced: number;
}

/** What one filter has matched so far, and how far it has read to say so. */
interface MatchedRows extends ProducedWindow {
	appendKey: unknown;
	outcome: StepListFilter["outcome"];
	query: string;
	/** How many source rows {@link total} counted. Never below `produced`. */
	scanned: number;
	/** How many of `steps[0, scanned)` the filter matched. */
	total: number;
}

/**
 * How many of `steps[from..]` the predicate matches, added to what was counted
 * before.
 *
 * Allocation-free by construction, which is the point: this is the pass that
 * has to run to the end of the list every flush, because the total is what the
 * window is sized against and what the "showing X of Y" line states.
 */
function countMatches(
	steps: readonly ScenarioStepRow[],
	match: (step: ScenarioStepRow) => boolean,
	from: number,
	counted: number
): number {
	let total = counted;
	for (let i = from; i < steps.length; i += 1) {
		if (match(steps[i])) total += 1;
	}
	return total;
}

/**
 * `held` extended to `wanted` rows, resuming at the source index it was last
 * produced through.
 *
 * Returns `held` itself once the window is full or the list holds nothing more:
 * that identity is what makes a flush past a filled window free, and it is what
 * the cost tests assert. The copy is made only once a row is actually found, so
 * a batch that matched nothing leaves the array alone rather than duplicating
 * it. Nothing already in `held.rows` is touched - a longer window is a new
 * array, so what a caller is holding cannot change under it.
 */
function growWindow(
	steps: readonly ScenarioStepRow[],
	match: (step: ScenarioStepRow) => boolean,
	held: ProducedWindow,
	wanted: number
): ProducedWindow {
	if (held.rows.length >= wanted || held.produced >= steps.length) return held;

	let grown: ScenarioStepRow[] | null = null;
	let have = held.rows.length;
	let i = held.produced;
	for (; i < steps.length && have < wanted; i += 1) {
		if (!match(steps[i])) continue;
		grown ??= [...held.rows];
		grown.push(steps[i]);
		have += 1;
	}
	// `i` is one past the row that filled the window, or the end of the list.
	return { rows: grown ?? held.rows, produced: i };
}

export function useFilteredSteps(
	steps: readonly ScenarioStepRow[],
	filter: StepListFilter,
	/**
	 * What says this is the same list as last render, only longer. Compared by
	 * identity, so any value a caller can hold stable across appends will do.
	 */
	appendKey: unknown,
	/**
	 * Which list this is, for the window's own reset. Deliberately *not*
	 * `appendKey`: a replay moves that, and a window that snapped back to the top
	 * on a reconnect would throw away a reader's scroll for a row they cannot
	 * see. The filter is added to it here, because a narrowed list is a new list
	 * and starts at its own top.
	 */
	listKey: string,
	step: number = GROWING_WINDOW_STEP
): FilteredStepWindow {
	const [matched, setMatched] = useState<MatchedRows | null>(null);

	/*
	 * Nothing narrows: there is no predicate to run and nothing to keep. What
	 * was kept is dropped, which matters - a filter cleared and pressed again
	 * must not extend rows gathered under the old one.
	 *
	 * This cannot return early, the shape the pre-window version of this hook
	 * used: `useGrowingWindow` is called below, and a hook behind a branch is a
	 * hook whose state moves. So the unnarrowed case walks the same path with no
	 * matcher, and every branch reads `match === null` as "the list itself".
	 */
	const match = narrowsSteps(filter) ? stepMatcher(filter) : null;

	const usable =
		match !== null &&
		matched !== null &&
		Object.is(matched.appendKey, appendKey) &&
		matched.outcome === filter.outcome &&
		matched.query === filter.query &&
		// A list that got shorter is not this list grown, whatever the key says.
		matched.scanned <= steps.length;

	/*
	 * The query is compared as typed rather than trimmed: two queries that
	 * differ only in whitespace match the same rows, so starting over for one is
	 * work that was not needed - but it is one keystroke's worth, and the
	 * alternative is this file holding its own opinion about what the predicate
	 * ignores. `narrowsSteps` is where that opinion lives.
	 */
	const held = usable ? matched : null;

	// Pass one, the count, over the rows that arrived since the last one.
	const total =
		match === null
			? steps.length
			: countMatches(steps, match, held?.scanned ?? 0, held?.total ?? 0);

	const growing = useGrowingWindow(
		total,
		step,
		`${listKey}:${filter.outcome ?? ""}:${filter.query}`
	);
	const wanted = growing.visible;

	// Pass two, the window, resumed from where it was produced through. With
	// nothing narrowing there is no predicate to resume: the window is a prefix
	// of the list itself, and the list itself when it fits - the same identity
	// `filterSteps` hands back.
	const shown: ProducedWindow =
		match === null
			? { rows: steps.length <= wanted ? steps : steps.slice(0, wanted), produced: 0 }
			: growWindow(
					steps,
					match,
					{ rows: held?.rows ?? NONE, produced: held?.produced ?? 0 },
					wanted
				);

	/*
	 * Adjusted during render rather than in an effect - the shape
	 * `useGrowingWindow` uses and React documents: the component re-renders
	 * immediately with what it just derived instead of painting a stale list and
	 * correcting it. It settles in one extra pass, because the second finds the
	 * whole list counted and the window already as long as it asked for.
	 */
	if (match === null) {
		if (matched !== null) setMatched(null);
	} else if (held === null || held.scanned !== steps.length || held.produced !== shown.produced) {
		setMatched({
			appendKey,
			outcome: filter.outcome,
			query: filter.query,
			scanned: steps.length,
			total,
			...shown,
		});
	}

	/*
	 * Longer than the window only when `visible` was reset under rows that stay
	 * valid, which takes `listKey` moving while the filter and `appendKey` hold
	 * still - the window's key carries the filter, so every other reset comes
	 * with a cache this cannot reuse anyway. That is reachable: `HistoryDetail`
	 * renders `ScenarioRunView` without a per-run key, so switching the open run
	 * changes `run.id` without remounting, and two runs that are both idle with
	 * no stored rows share an `appendKey` (`0`, and the one `EMPTY_STEPS`).
	 *
	 * What was found stays found - the cache keeps it, and a sentinel that grows
	 * `visible` again asks for none of it twice - while the view is handed the
	 * window it asked for, so the rows on screen and the "showing X of Y" line
	 * beside them cannot disagree. The re-slice per render that costs is bounded
	 * by `visible` and lasts until the window grows back past what is held.
	 */
	return {
		total,
		rows: shown.rows.length > wanted ? shown.rows.slice(0, wanted) : shown.rows,
		sentinelRef: growing.sentinelRef,
		hasMore: growing.hasMore,
	};
}
