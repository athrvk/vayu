/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useRef } from "react";
import type { RowAction } from "./row-actions";

/**
 * Lets an action opening an `autoFocus` field wait for its menu to close (#3443). `onSelect` runs
 * while the menu's `FocusScope` traps focus, so a field it mounts is yanked back into the menu,
 * which then closes and hands focus to the row: typing drives the tree's typeahead, Backspace
 * trashes the row, and a rename's blur commits the name unchanged. `onCloseAutoFocus` is Radix's
 * cleanup-done signal, so an `opensField` action runs there and the hand-back to the row is
 * skipped. Shared by both menus (`RowActionsMenu`, `RowContextMenuContent`), different Radix
 * families with the same trap. One slot suffices: a modal menu selects one item per opening.
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
	 * Call first from `onCloseAutoFocus`: runs the deferred action, if any, stops Radix returning
	 * focus over the field the action opens, and reports whether it did, so the caller leaves its
	 * own focus return alone.
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
