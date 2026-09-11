/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the history list's one tab stop is, and which row should hold it.
 *
 * The same roving-tabindex shape `tree-focus.ts` gives the collection tree -
 * one Tab stop for the whole list instead of one per row - stripped to the
 * flat case: no hierarchy, no expand/collapse, so none of that file's
 * depth/parent logic. `useHistoryListFocus.ts` is the keydown half.
 */

/**
 * A row's activator - the stretched button `RunItem` renders last, which
 * opens the run. Its own attribute rather than the tree's `data-tree-activate`:
 * this list is not a tree, and sharing the attribute would make a future
 * tree-only fix silently reach here too.
 */
export const HISTORY_ROW_ACTIVATE = "[data-history-activate]";

/** Every row's activator, in the order the list renders them. Day-group
 *  headers carry no such attribute, so they are never in this list. */
export function historyRows(container: HTMLElement | null | undefined): HTMLElement[] {
	return Array.from(container?.querySelectorAll<HTMLElement>(HISTORY_ROW_ACTIVATE) ?? []);
}

/**
 * Focus `row` and move the list's single tab stop onto it.
 *
 * Every other row is reset first - promoting the destination alone leaks a
 * stop per call, the same reasoning `focusTreeRow` documents: a DOM mutation
 * on top of a vdom prop that did not change, so React re-renders to nothing
 * and each stray `0` survives.
 */
export function focusHistoryRow(
	container: HTMLElement | null | undefined,
	row: HTMLElement | null | undefined
): void {
	if (!row) return;
	for (const item of historyRows(container)) item.tabIndex = -1;
	row.tabIndex = 0;
	row.focus();
}
