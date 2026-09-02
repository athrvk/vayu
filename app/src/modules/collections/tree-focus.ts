/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the tree's one tab stop is, and which row should hold it.
 *
 * The tree is a single Tab stop with a roving tabindex, so moving focus is
 * never just `.focus()` - the stop has to move with it, or the next Tab returns
 * to a row the user has since navigated away from. That two-step lived in
 * `useRovingTreeFocus` and was copied into `useRevealActiveSelection`; the
 * delete refocus (#1218) would have been a third. It is one function here, and
 * the callers share it.
 */

/** What a row is, everywhere the tree reads one out of the DOM. */
export const TREE_ITEM = '[role="treeitem"]';

/** Every visible row, in the order the tree renders them. */
export function treeRows(tree: HTMLElement | null | undefined): HTMLElement[] {
	return Array.from(tree?.querySelectorAll<HTMLElement>(TREE_ITEM) ?? []);
}

/**
 * Focus `row` and move the tree's single tab stop onto it.
 *
 * Every other row is reset first. Promoting the destination alone leaks a stop
 * per call: this is a DOM mutation on top of a vdom prop that did not change,
 * so React re-renders to nothing and each stray `0` survives.
 */
export function focusTreeRow(
	tree: HTMLElement | null | undefined,
	row: HTMLElement | null | undefined
): void {
	if (!row) return;
	for (const item of treeRows(tree)) item.tabIndex = -1;
	row.tabIndex = 0;
	row.focus();
}

/** A row's depth, 1-based, as the tree announces it. */
function levelOf(row: HTMLElement): number {
	return Number(row.getAttribute("aria-level") ?? 1);
}

/**
 * The row that should hold focus once `row` and everything under it is gone:
 * the following sibling, the parent when it was the last child, and the row
 * before it when it was the last child of the root.
 *
 * Depth comes from `aria-level` rather than the DOM shape. The rows between a
 * folder and its next sibling are its descendants, and they die with it - a
 * "next row in document order" rule would hand focus to one of them.
 */
export function rowAfterRemoving(
	tree: HTMLElement | null | undefined,
	row: HTMLElement
): HTMLElement | null {
	const rows = treeRows(tree);
	const index = rows.indexOf(row);
	if (index === -1) return null;

	const level = levelOf(row);
	let after = index + 1;
	while (after < rows.length && levelOf(rows[after]) > level) after++;

	if (after < rows.length && levelOf(rows[after]) === level) return rows[after];

	// Nothing follows it in its own set, so the parent survives it: the nearest
	// row above it that is shallower. Read off `aria-level` rather than through
	// the tree's own parent walk, which takes the first treeitem in an ancestor
	// and so can answer with a preceding sibling - harmless for Left-arrow,
	// wrong for choosing what outlives a row.
	for (let above = index - 1; above >= 0; above--) {
		if (levelOf(rows[above]) < level) return rows[above];
	}
	// A root row with no root after it. The row before it is another root, or
	// something under one, and either survives.
	return rows[index - 1] ?? null;
}
