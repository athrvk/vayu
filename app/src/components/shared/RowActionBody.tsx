/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What one row action draws, in either menu (the `⋯` dropdown or the right-click menu, #1360); the
 * other row-action rules are in `row-actions.ts`.
 */

import type { RowAction } from "./row-actions";

/**
 * An item's contents: glyph, label, then a trailing column with the reason the item is off or the
 * value it carries (#1690). `data-icon-motion` arrives in a variable no source scan sees; the
 * rendered-class half of `icon-motion.call-sites.test.tsx` holds it. `ml-auto`, not a gap: a menu
 * sizes to its widest row, so a reason sitting where its label ends would read as part of "Move up"
 * on one row and not the next. `text-muted-foreground` keeps it behind the label on enabled items
 * too, a disabled one being at the menu's disabled opacity already.
 */
export function RowActionBody({ action }: { action: RowAction }) {
	const Icon = action.icon;
	// Why it is off beats what it carries: a Copy that cannot run describes no value the user can
	// have.
	const trailing = (action.disabled ? action.disabledReason : undefined) ?? action.hint;
	return (
		<>
			<Icon className="size-icon shrink-0" data-icon-motion={action.iconMotion} />
			{action.label}
			{trailing ? (
				// `max-w-[12rem] truncate`: a hint is often a URL, and uncapped one inbox row set
				// every item's width. A literal rem, as a text measure: `max-w-48` rides
				// `--spacing` and tightens at Default, and no named step sits below `3xs` (16rem).
				<span className="ml-auto max-w-[12rem] truncate pl-3 text-xs text-muted-foreground">
					{trailing}
				</span>
			) : null}
		</>
	);
}
