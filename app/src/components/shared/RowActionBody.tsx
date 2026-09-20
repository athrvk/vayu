/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one row action draws, for whichever of the two menus is drawing it - the
 * `⋯` dropdown or the right-click menu (#1360). The rest of the rules about a
 * row's actions are in `row-actions.ts`.
 */

import type { RowAction } from "./row-actions";

/**
 * An item's contents: its glyph, then its label, then a trailing column holding
 * either the reason the item is off or the value it carries (#1690).
 *
 * `data-icon-motion` arrives in a variable, so no source scan can see it - the
 * rendered-class half of `icon-motion.call-sites.test.tsx` is what holds it.
 *
 * `ml-auto` rather than a gap: the reason is a second column, and a menu sizes
 * itself to its widest row, so letting it sit where the label ends would leave
 * "Already first" reading as part of "Move up" on the one row and not on the
 * next. `text-muted-foreground` keeps it behind the label whichever it is - a
 * disabled item is already at the menu's own disabled opacity, and the column
 * has to stay secondary on an enabled one too.
 *
 * `data-icon-motion` arrives in a variable, so no source scan can see it - the
 * rendered-class half of `icon-motion.call-sites.test.tsx` is what holds it.
 */
export function RowActionBody({ action }: { action: RowAction }) {
	const Icon = action.icon;
	// Why it is off wins over what it carries: a Copy that cannot run is not
	// describing a value the user can have.
	const trailing = (action.disabled ? action.disabledReason : undefined) ?? action.hint;
	return (
		<>
			<Icon className="size-icon shrink-0" data-icon-motion={action.iconMotion} />
			{action.label}
			{trailing ? (
				// `max-w-48 truncate`: a hint is often a URL, and a menu sizes
				// itself to its widest row - uncapped, one inbox row set the width
				// of every item beside it.
				<span className="ml-auto max-w-48 truncate pl-3 text-xs text-muted-foreground">
					{trailing}
				</span>
			) : null}
		</>
	);
}
