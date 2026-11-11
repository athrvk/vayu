/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef } from "react";
import type { RowAction } from "./row-actions";

/**
 * Lets an action that opens an `autoFocus` field wait for its menu to finish
 * closing (#3443).
 *
 * `onSelect` runs while the menu's `FocusScope` is still trapping focus, so a
 * field mounted by it claims focus and is yanked straight back into the menu;
 * the menu then closes and hands focus to the row. The field ends up unfocused
 * with the row holding the keys: typing drives the tree's typeahead and
 * Backspace trashes the row, and a rename's blur commits the name unchanged.
 * `onCloseAutoFocus` is Radix's signal that the cleanup is done, so an action
 * marked `opensField` is run from there and the hand-back to the row is
 * skipped. Shared by both menus (`RowActionsMenu`, `RowContextMenuContent`),
 * which are different Radix families with the same trap.
 *
 * One slot is enough: a modal menu has one item selected per opening.
 */
export function useAfterMenuClose() {
	const pending = useRef<(() => void) | null>(null);

	/** What an item's `onSelect` should be: the action itself, or its deferral. */
	const onSelectOf = (action: RowAction): (() => void) =>
		action.opensField
			? () => {
					pending.current = action.onSelect;
				}
			: action.onSelect;

	/**
	 * Call first from `onCloseAutoFocus`. Runs the deferred action, if any, and
	 * stops Radix handing focus back over the field it opens. Reports whether
	 * it did, so the caller can leave its own focus return alone.
	 */
	const runDeferred = (event: Event): boolean => {
		const run = pending.current;
		if (!run) return false;
		pending.current = null;
		event.preventDefault();
		run();
		return true;
	};

	return { onSelectOf, runDeferred };
}
