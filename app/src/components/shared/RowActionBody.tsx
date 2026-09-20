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
 * An item's contents: its glyph, then its label.
 *
 * `data-icon-motion` arrives in a variable, so no source scan can see it - the
 * rendered-class half of `icon-motion.call-sites.test.tsx` is what holds it.
 */
export function RowActionBody({ action }: { action: RowAction }) {
	const Icon = action.icon;
	return (
		<>
			<Icon className="size-icon shrink-0" data-icon-motion={action.iconMotion} />
			{action.label}
		</>
	);
}
