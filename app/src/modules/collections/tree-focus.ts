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
 * The row that owns `rows[index]`: the nearest row above it that is shallower.
 * `null` for a root, which is the honest answer rather than a near miss.
 *
 * Depth comes from `aria-level`, never from the DOM shape, and this is the one
 * reading of the hierarchy the whole tree uses - navigation and delete refocus
 * alike. A row's children are rendered as a *sibling* of that row rather than
 * inside it, so `closest()` finds no parent and a walk up the ancestors answers
 * with whichever treeitem an ancestor holds first: the group's own first row,
 * which is a preceding *sibling* of every row after it. That walk sent
 * ArrowLeft to the top of a list instead of out of it (#1237). Two of the three
 * trees defeat any shape-based rule outright - the schema explorer renders every
 * row, at every depth, as a direct child of `role="tree"` - while `aria-level`
 * is on every row of all three, because the same sibling shape is why the
 * hierarchy has to be announced rather than inferred.
 *
 * Takes the row list rather than the tree: both callers already hold one, and
 * re-querying per row turned the `*` key into a DOM sweep per candidate.
 */
export function parentRow(rows: HTMLElement[], index: number): HTMLElement | null {
	const row = rows[index];
	if (!row) return null;

	const level = levelOf(row);
	for (let above = index - 1; above >= 0; above--) {
		if (levelOf(rows[above]) < level) return rows[above];
	}
	return null;
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

	// Nothing follows it in its own set, so the parent survives it.
	const parent = parentRow(rows, index);
	if (parent) return parent;

	// A root row with no root after it. The row before it is another root, or
	// something under one, and either survives.
	return rows[index - 1] ?? null;
}
