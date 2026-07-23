/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Roving tabindex for the collection tree (WAI-ARIA treeview pattern).
 *
 * The tree is a single tab stop. Arrow keys move between rows, so tabbing past
 * the tree costs one press instead of one per row - previously a workspace with
 * 2 collections and 4 requests cost 17.
 *
 * Visible order comes from the DOM (`[role="treeitem"]` in document order):
 * collapsed subtrees are not rendered, so the NodeList is exactly the rows a
 * user can see, in the order they see them. That avoids maintaining a second,
 * flattenable copy of the tree purely for navigation.
 *
 * Rows expose their behaviour through data attributes rather than props, so
 * this needs nothing threaded through CollectionItem's prop list:
 *   data-tree-activate  the primary control (open the collection/request)
 *   data-tree-toggle    expand/collapse control (collections only)
 *   data-tree-menu      row actions            (Shift+F10 / Menu key)
 *   data-tree-rename    rename control         (F2 key)
 *   data-tree-delete    delete control         (Delete key)
 *
 * Focus is deliberately separate from selection: arrows move focus without
 * opening anything; Enter/Space opens.
 */

import { useCallback, useEffect, type RefObject } from "react";

const ITEM = '[role="treeitem"]';

/**
 * A row's children are rendered as a *sibling* of that row, both inside a
 * per-collection wrapper - not nested inside the row - so `closest(ITEM)` never
 * finds the parent. Walk up instead, and at each ancestor take the first
 * treeitem it contains: the first wrapper that holds a treeitem other than this
 * one is the parent's wrapper, and that treeitem is the parent row. Stops at the
 * tree so a root row correctly reports no parent instead of picking up its
 * preceding sibling.
 */
function parentItem(current: HTMLElement): HTMLElement | null {
	const tree = current.closest('[role="tree"]');
	let node = current.parentElement;
	while (node && node !== tree && tree?.contains(node)) {
		const first = node.querySelector<HTMLElement>(ITEM);
		if (first && first !== current) return first;
		node = node.parentElement;
	}
	return null;
}

export function useRovingTreeFocus(treeRef: RefObject<HTMLElement | null>) {
	const items = useCallback(
		() => Array.from(treeRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []),
		[treeRef]
	);

	const focusItem = useCallback(
		(el: HTMLElement | undefined) => {
			if (!el) return;
			for (const item of items()) item.tabIndex = -1;
			el.tabIndex = 0;
			el.focus();
		},
		[items]
	);

	// Exactly one row must be tabbable. Rows render with tabIndex -1, so seed
	// the first one - and re-seed if the row holding it was collapsed away.
	useEffect(() => {
		const list = items();
		if (list.length && !list.some((i) => i.tabIndex === 0)) list[0].tabIndex = 0;
	});

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLElement>) => {
			const active = document.activeElement;
			if (!(active instanceof HTMLElement)) return;
			const current = active.closest<HTMLElement>(ITEM);
			if (!current || !treeRef.current?.contains(current)) return;

			// Never hijack typing in a rename field.
			if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") return;

			const list = items();
			const i = list.indexOf(current);
			const expanded = current.getAttribute("aria-expanded");
			const click = (sel: string) => current.querySelector<HTMLElement>(sel)?.click();
			const take = () => {
				e.preventDefault();
				e.stopPropagation();
			};

			switch (e.key) {
				case "ArrowDown":
					take();
					focusItem(list[i + 1]);
					break;
				case "ArrowUp":
					take();
					focusItem(list[i - 1]);
					break;
				case "Home":
					take();
					focusItem(list[0]);
					break;
				case "End":
					take();
					focusItem(list[list.length - 1]);
					break;
				case "ArrowRight":
					take();
					// Collapsed: open it. Children mount on the next render, so a
					// second press steps into them - no flushSync needed.
					if (expanded === "false") click("[data-tree-toggle]");
					else if (expanded === "true") focusItem(list[i + 1]);
					break;
				case "ArrowLeft":
					take();
					if (expanded === "true") click("[data-tree-toggle]");
					else {
						const parent = parentItem(current);
						if (parent) focusItem(parent);
					}
					break;
				case "Enter":
				case " ":
					take();
					click("[data-tree-activate]");
					break;
				case "F2":
					take();
					click("[data-tree-rename]");
					break;
				case "Delete":
					take();
					click("[data-tree-delete]");
					break;
				case "ContextMenu":
					take();
					click("[data-tree-menu]");
					break;
				case "F10":
					if (e.shiftKey) {
						take();
						click("[data-tree-menu]");
					}
					break;
			}
		},
		[items, focusItem, treeRef]
	);

	// Clicking a row makes it the tabbable one, so Tab returns where you left off.
	const onFocus = useCallback(
		(e: React.FocusEvent<HTMLElement>) => {
			const item = e.target.closest<HTMLElement>(ITEM);
			if (!item || item.tabIndex === 0) return;
			for (const other of items()) other.tabIndex = -1;
			item.tabIndex = 0;
		},
		[items]
	);

	return { onKeyDown, onFocus };
}
