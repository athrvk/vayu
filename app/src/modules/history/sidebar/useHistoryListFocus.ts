/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Roving tabindex for the history list.
 *
 * Up/Down/Home/End move focus between runs; nothing opens until Enter or
 * Space. That split - moving focus and opening the focused item are two
 * separate steps - is the industry-standard shape for a list this size:
 * Gmail's message list, Slack's channel/DM list, Finder/Explorer's list
 * view and VS Code's own tree and quick-open lists all move a highlight on
 * arrow keys and act only on Enter (or a click). Auto-opening on every arrow
 * press would fire a run's worth of navigation - a query, a tab - once per
 * row skimmed past rather than once for the row landed on.
 *
 * Simpler than `useRovingTreeFocus`, the same pattern for the collection
 * tree: no Left/Right (no hierarchy to walk), no typeahead, and no Enter/
 * Space handling of its own, because a history row's activator is a real
 * `<button>` (`RunItem`'s stretched click target) - a focused button already
 * activates on either key with no listener here, unlike a tree row, which is
 * a `div` wrapping a separate `data-tree-activate` button and so has to
 * spell activation out itself.
 */

import { useCallback, useEffect, type RefObject } from "react";
import { isTextEntryTarget } from "@/lib/keyboard";
import { HISTORY_ROW_ACTIVATE as ROW, focusHistoryRow, historyRows } from "./history-row-focus";

export function useHistoryListFocus(containerRef: RefObject<HTMLElement | null>) {
	const rows = useCallback(() => historyRows(containerRef.current), [containerRef]);

	// Exactly one row must be tabbable. Seed the first on mount, and re-seed
	// whenever the row holding it is no longer in the list - deleted, or
	// dropped by a filter/sort/search change - the same effect
	// `useRovingTreeFocus` runs for a collapsed-away tree row.
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

	// Clicking a row makes it the tabbable one, so Tab returns where you left
	// off - same as the tree.
	const onFocus = useCallback(
		(e: React.FocusEvent<HTMLElement>) => {
			const item = e.target.closest<HTMLElement>(ROW);
			if (!item || item.tabIndex === 0) return;
			for (const other of rows()) other.tabIndex = -1;
			item.tabIndex = 0;
		},
		[rows]
	);

	return { onKeyDown, onFocus };
}
