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
 *   data-tree-menu      row actions            (Shift+F10 / Menu / Shift+Enter)
 *   data-tree-rename    rename control         (F2 key)
 *   data-tree-delete    delete control         (Delete / Backspace)
 *   data-tree-label     the row's name         (typeahead)
 *   data-tree-move-*    reorder controls       (Alt+Arrow)
 *
 * Focus is deliberately separate from selection: arrows move focus without
 * opening anything; Enter/Space opens.
 *
 * **Two of those keys do not exist on a Mac keyboard**, which is why each has a
 * second binding (#931):
 *
 *   - The key labelled "delete" on a Mac reports `"Backspace"`. `"Delete"` is
 *     forward-delete, Fn+Delete, which effectively nobody presses - so a
 *     `"Delete"`-only handler is dead on macOS. Both are accepted here on every
 *     platform rather than behind an `isMac` fork: Backspace-to-delete is
 *     standard list behaviour, and the control this clicks opens the
 *     confirm dialog, so a mistaken press costs a dialog rather than data.
 *   - Mac keyboards have no Menu key, and F10 is a media key by default, so the
 *     row menu had no keyboard path at all there. **Shift+Enter** is the third
 *     one; plain Enter still activates.
 *
 * **F2 keeps no second binding, deliberately** (#935). It is a media key by
 * default on a Mac too, so it shares the F10 problem - but not its consequence:
 * rename is reachable without it by double-click and by the row menu (itself
 * reachable from the keyboard through Shift+Enter), whereas the row menu had no
 * path at all. Adding a chord for it would spend one of the few free ones on a
 * key that is only inconvenient, so this is recorded rather than fixed.
 *
 * **Ctrl/Cmd is the app's, not the tree's**, and the bail-out for it is in
 * `onKeyDown` rather than in each case: the named cases match on `e.key` alone
 * and `take()` stops propagation, so with a row focused - the normal state
 * after opening a request - `mod+Enter` re-activated the row and the window's
 * send listener never heard it (#935, from #931's review).
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { TIMING } from "@/config/timing";
import { isTextEntryTarget } from "@/lib/keyboard";

const ITEM = '[role="treeitem"]';

/**
 * Alt+Arrow moves the row itself, rather than the focus - the keyboard half of
 * drag-and-reorder (#364 decision 8). Left and right are "out of" and "into",
 * matching the plain arrows' collapse/expand direction so the pair reads as one
 * mental model rather than two.
 *
 * Alt is the modifier because the tree owns the bare arrows for navigation and
 * the app owns Ctrl/Cmd; a chord is also why the row menu carries a
 * "Move to..." action that needs no keyboard at all.
 */
const MOVE_CONTROL: Record<string, string> = {
	ArrowUp: "[data-tree-move-up]",
	ArrowDown: "[data-tree-move-down]",
	ArrowRight: "[data-tree-move-in]",
	ArrowLeft: "[data-tree-move-out]",
};

/**
 * A row's name, for typeahead.
 *
 * `data-tree-label` rather than `textContent`: a request row's text starts with
 * its method badge, so "Get users" reads as "GETGet users" and typing `g`,`e`
 * matches by accident while typing `l` for "List orders" matches nothing at all.
 * A collection row ends with its child count for the same reason. The attribute
 * is the name the user actually sees. Falls back to the text so a row that has
 * not declared one is merely imprecise rather than unreachable.
 */
function labelOf(el: HTMLElement): string {
	return (el.getAttribute("data-tree-label") ?? el.textContent ?? "").trim().toLowerCase();
}

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
	// The typeahead buffer and when it was last appended to. A ref, not state:
	// nothing renders from it, and a render per keystroke would rebuild every
	// row in the tree just to move focus by one.
	const typeahead = useRef({ prefix: "", at: 0 });

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

			// Never hijack typing in a rename field. The set is the one the send
			// chord's handler excludes, widened by the plain input a rename is -
			// one definition, so the two guards cannot drift apart again.
			if (isTextEntryTarget(active)) return;

			// Ctrl/Cmd chords belong to the app. Bailing out here rather than in
			// each case is what lets the window handlers hear them at all - see
			// the header note.
			if (e.ctrlKey || e.metaKey) return;

			const list = items();
			const i = list.indexOf(current);
			const expanded = current.getAttribute("aria-expanded");
			const click = (sel: string) => current.querySelector<HTMLElement>(sel)?.click();
			const take = () => {
				e.preventDefault();
				e.stopPropagation();
			};

			// Before the switch: Alt+Arrow is a move, not a navigation, and the
			// four keys it uses all mean something else without the modifier.
			if (e.altKey && MOVE_CONTROL[e.key]) {
				take();
				click(MOVE_CONTROL[e.key]);
				return;
			}

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
					else if (expanded === "true") {
						// Expanded: move to the *first child*, and nowhere at all if
						// there is none. An empty folder renders an "Empty folder"
						// div rather than a treeitem, so the next row in document
						// order is its sibling and stepping to it was an ArrowDown
						// wearing ArrowRight's key (#931 review). Parentage decides,
						// the same walk the `*` case uses.
						const next = list[i + 1];
						if (next && parentItem(next) === current) focusItem(next);
					}
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
					// Shift+Enter is the row menu's Mac-reachable path (see the
					// header note). Space is left alone: it is the activate key
					// that does not double as a chord anywhere in the app.
					if (e.key === "Enter" && e.shiftKey) click("[data-tree-menu]");
					else click("[data-tree-activate]");
					break;
				case "F2":
					take();
					click("[data-tree-rename]");
					break;
				case "Delete":
				case "Backspace":
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
				case "*": {
					take();
					// Expand every sibling folder of the focused row. Siblinghood
					// comes from the DOM walk rather than from props: two rows are
					// siblings when `parentItem` returns the same row, which is
					// `null` for two roots. Already-expanded rows are skipped, so
					// this never collapses anything.
					const parent = parentItem(current);
					for (const item of list) {
						if (item.getAttribute("aria-expanded") !== "false") continue;
						if (parentItem(item) !== parent) continue;
						item.querySelector<HTMLElement>("[data-tree-toggle]")?.click();
					}
					break;
				}
				default: {
					// Typeahead. Printable characters only, and never a shortcut:
					// Alt combinations belong to the app, not to the tree (Ctrl/Cmd
					// left before the switch). Space never arrives here - it
					// activates, above.
					if (e.key.length !== 1 || e.altKey) break;
					take();
					const now = Date.now();
					const stale = now - typeahead.current.at > TIMING.TREE_TYPEAHEAD_MS;
					const prefix = (stale ? "" : typeahead.current.prefix) + e.key.toLowerCase();
					typeahead.current = { prefix, at: now };

					// Repeating one letter cycles through the rows starting with it,
					// rather than building "ppp" - which no row can match, so the
					// most natural way to ask for "the next Payments-ish row" would
					// silently do nothing. The ARIA practices call this out by name.
					const repeated = [...prefix].every((c) => c === prefix[0]);
					const search = repeated ? prefix[0] : prefix;

					// A single letter searches from the row *after* the current one,
					// so pressing it again steps on. A longer prefix includes the
					// current row, which is the one it most likely still describes -
					// otherwise typing "in" would jump off "Invoices" the moment the
					// "n" landed.
					const start = search.length === 1 ? i + 1 : i;
					for (let n = 0; n < list.length; n++) {
						const candidate = list[(start + n + list.length) % list.length];
						if (labelOf(candidate).startsWith(search)) {
							focusItem(candidate);
							break;
						}
					}
					break;
				}
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
