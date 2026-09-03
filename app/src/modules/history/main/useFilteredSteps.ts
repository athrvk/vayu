/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The step rows a filter matches, kept across a live run's commits (#1205).
 *
 * A scenario run's list grows for the length of the run and every batch hands
 * the view a new array (immutability, which zustand's change detection depends
 * on). Filtering that array per commit therefore ran the predicate over every
 * row the run had produced, every flush - and the predicate is the expensive
 * kind: a search lowercases each step's name, allocating a string per row per
 * flush. The default view escaped it because {@link filterSteps} hands the list
 * straight back when nothing narrows, so the cost fell on exactly the reader
 * who had pressed a chip or typed in the box.
 *
 * The rows the filter already matched do not change when more arrive at the
 * end, so this keeps them and tests the batch alone. Two things make that safe
 * rather than a guess:
 *
 * - **The fold says when a list only grew.** `appendKey` is what identifies
 *   *which* list this is - the store's `appendEpoch` for the live rows, the
 *   array itself for the stored ones - the same shape as `useGrowingWindow`'s
 *   `resetKey`, and for the same reason. It moves whenever anything but an
 *   append happened, so a replay that replaced a row, a run that restarted, or
 *   the changeover to stored rows starts the matching over.
 * - **A missed commit cannot slip through.** The epoch is monotone, so two
 *   commits coalesced into one render are still either "both appended" (the
 *   rows held still hold) or "the number moved" (start over). Nothing compares
 *   rows to decide, which is the scan this exists to avoid.
 *
 * **What a commit still costs, and why it stays.** The matched rows are rebuilt
 * as one array on a commit whose batch matched something, so that copy is
 * proportional to what has matched rather than to the batch. It is the same
 * class of cost - and at most the same size - as the copy `foldStepEvents`
 * makes of the whole list on the same commit, which immutability requires;
 * removing it would mean appending to an array in place across renders, which
 * is the impure render this repo's `react-hooks` rules refuse. What is gone is
 * the predicate pass over the run, the part that lowercased a string per row.
 * Issue #1297 holds the window-bounded route for the day the copy measures.
 */

import { useState } from "react";
import {
	filterSteps,
	narrowsSteps,
	type ScenarioStepRow,
	type StepListFilter,
} from "./scenario-steps";

/** Shared, so a batch that matched nothing costs no allocation at all. */
const NONE: readonly ScenarioStepRow[] = [];

export interface FilteredStepList {
	/** How many rows matched - the total the "showing X of Y" line states. */
	total: number;
	/** The first `count` matching rows, in plan order. A fresh array. */
	take: (count: number) => ScenarioStepRow[];
}

/** What one filter has matched so far, and how much of the list it has seen. */
interface MatchedRows {
	appendKey: unknown;
	outcome: StepListFilter["outcome"];
	query: string;
	/** How many source rows {@link rows} was matched from. */
	scanned: number;
	/** Those of them the filter matched, in plan order. */
	rows: readonly ScenarioStepRow[];
}

export function useFilteredSteps(
	steps: readonly ScenarioStepRow[],
	filter: StepListFilter,
	/**
	 * What says this is the same list as last render, only longer. Compared by
	 * identity, so any value a caller can hold stable across appends will do.
	 */
	appendKey: unknown
): FilteredStepList {
	const [matched, setMatched] = useState<MatchedRows | null>(null);

	// Nothing narrows: `filterSteps` would hand the list back untouched, so
	// there is nothing to match and nothing to keep. Dropping what was kept
	// matters - a filter cleared and pressed again must not extend rows
	// gathered under the old one.
	if (!narrowsSteps(filter)) {
		if (matched !== null) setMatched(null);
		return { total: steps.length, take: (count) => steps.slice(0, count) };
	}

	/*
	 * The query is compared as typed rather than trimmed: two queries that
	 * differ only in whitespace match the same rows, so starting over for one is
	 * work that was not needed - but it is one keystroke's worth, and the
	 * alternative is this file holding its own opinion about what the predicate
	 * ignores. `narrowsSteps` is where that opinion lives.
	 */
	const usable =
		matched !== null &&
		Object.is(matched.appendKey, appendKey) &&
		matched.outcome === filter.outcome &&
		matched.query === filter.query &&
		// A list that got shorter is not this list grown, whatever the key says.
		matched.scanned <= steps.length;

	const held = usable ? matched : null;
	const scanned = held?.scanned ?? 0;
	// The one predicate, over the rows that arrived since the last pass and
	// nothing else. Appended rows sort after every row already held, so what
	// they match goes on the end and plan order needs no merge.
	const added = scanned < steps.length ? filterSteps(steps.slice(scanned), filter) : NONE;
	const rows = added.length === 0 ? (held?.rows ?? NONE) : [...(held?.rows ?? NONE), ...added];

	/*
	 * Adjusted during render rather than in an effect - the shape
	 * `useGrowingWindow` uses and React documents: the component re-renders
	 * immediately with what it just derived instead of painting a stale list and
	 * correcting it. It settles in one extra pass, because the second finds the
	 * whole list already matched and asks for nothing.
	 */
	if (held === null || scanned < steps.length) {
		setMatched({
			appendKey,
			outcome: filter.outcome,
			query: filter.query,
			scanned: steps.length,
			rows,
		});
	}

	return { total: rows.length, take: (count) => rows.slice(0, count) };
}
