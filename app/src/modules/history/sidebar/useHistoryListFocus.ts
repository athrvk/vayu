/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Roving tabindex for the history list. Up/Down/Home/End move focus between runs; nothing opens
 * until Enter or Space. Moving focus and opening are two steps, as in Gmail's message list, Slack's
 * channel list, Finder/Explorer's list view and VS Code's lists: opening on every arrow press would
 * fire a run's navigation (a query, a tab) for each row skimmed past rather than once for the row
 * landed on.
 *
 * Simpler than `useRovingTreeFocus` (the collection tree's): no Left/Right (no hierarchy), no
 * typeahead, and no Enter/Space handling, because a history row's activator is a real `<button>`
 * (`RunItem`'s stretched click target) that activates on either key by itself, unlike a tree row, a
 * `div` around a separate `data-tree-activate` button that has to spell activation out.
 */

import { useCallback, useEffect, type RefObject } from "react";
import { isTextEntryTarget } from "@/lib/keyboard";
import { HISTORY_ROW_ACTIVATE as ROW, focusHistoryRow, historyRows } from "./history-row-focus";

/**
 * @param onReachEnd Called when focus lands on the last row rendered. A windowed list
 *        (`HistoryList`) grows there so the next ArrowDown has a row to move to: the sentinel that
 *        grows it on scroll can sit just past the scroller's edge when a keyboard moved the focus.
 */
export function useHistoryListFocus(
	containerRef: RefObject<HTMLElement | null>,
	onReachEnd?: () => void
) {
	const rows = useCallback(() => historyRows(containerRef.current), [containerRef]);

	// Exactly one row must be tabbable: seed the first on mount, and re-seed whenever the row
	// holding the stop leaves the list (deleted, or dropped by a filter/sort/search change), as
	// `useRovingTreeFocus` does for a collapsed-away row.
	useEffect(() => {
		const list = rows();
		if (list.length && !list.some((r) => r.tabIndex === 0)) list[0].tabIndex = 0;
	});

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement)) return;
			const current = active.closest<HTMLElement>(ROW);
			if (!current || !containerRef.current?.contains(current)) return;

			// Never hijack typing in the search box or any other field - the
			// same guard `useRovingTreeFocus` applies for a rename field.
			if (isTextEntryTarget(active)) return;
			// Chords belong to the app or the browser, not this list.
			if (e.ctrlKey || e.metaKey || e.altKey) return;

			const list = rows();
			const i = list.indexOf(current);

			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					focusHistoryRow(containerRef.current, list[i + 1]);
					break;
				case "ArrowUp":
					e.preventDefault();
					focusHistoryRow(containerRef.current, list[i - 1]);
					break;
				case "Home":
					e.preventDefault();
					focusHistoryRow(containerRef.current, list[0]);
					break;
				case "End":
					e.preventDefault();
					focusHistoryRow(containerRef.current, list[list.length - 1]);
					break;
				default:
					break;
			}
		},
		[rows, containerRef]
	);

	// A clicked row becomes the tabbable one, so Tab returns where you left off, as in the tree.
	const onFocus = useCallback(
		(e: React.FocusEvent<HTMLElement>) => {
			const item = e.target.closest<HTMLElement>(ROW);
			if (!item) return;
			// Before the tab-stop early return below: End and ArrowDown promote the
			// destination to the stop themselves, so it arrives already at 0.
			if (onReachEnd) {
				const list = rows();
				if (list[list.length - 1] === item) onReachEnd();
			}
			if (item.tabIndex === 0) return;
			for (const other of rows()) other.tabIndex = -1;
			item.tabIndex = 0;
		},
		[rows, onReachEnd]
	);

	return { onKeyDown, onFocus };
}
