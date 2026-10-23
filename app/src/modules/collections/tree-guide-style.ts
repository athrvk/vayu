/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { CSSProperties } from "react";
import { rowInsetPx } from "@/constants/layout";

/** The divider colour each surface retunes, so a guide reads on the panel it sits on. */
const GUIDE_COLOR = "var(--rule)";
/** The selected request's folder level: `--primary` at about half strength. */
const ACTIVE_GUIDE_COLOR = "hsl(var(--primary) / 0.5)";

/** A colour as a gradient layer, the one way a background paints a solid line. */
const layer = (color: string) => `linear-gradient(${color}, ${color})`;

/**
 * The centre of level `level`'s chevron, which is where its guide runs. Read
 * off `--spacing-target`, so it follows the density setting with the chevron.
 */
const guideX = (level: number) => `calc(${rowInsetPx(level)}px + var(--spacing-target) / 2)`;

/**
 * The indent guides of a row at `depth` (#2773): one 1px vertical line for each
 * ancestor level, drawn as background layers on the row itself so a level costs
 * no DOM node. Each row's segment (and its wrapper's, across the gap above it)
 * joins its neighbours' into one line from below a folder to its last visible
 * descendant.
 *
 * `activeGuideLevel` adds one accent layer over that level's line, the selected
 * request's folder. A background image paints over the row's fill and under its
 * content, so the guides stay visible on a selected or hovered row.
 *
 * Spread beside `paddingLeft`; a depth-0 row has no ancestors and gets nothing.
 *
 * `gapUnits` is for the wrapper around a row: the space above a row is padding
 * on that wrapper (`CollectionTreeRows`), outside the row's own box, so the
 * wrapper paints the same lines across just that strip, in `--spacing` units.
 * Only the strip, never the wrapper's full height: the row paints its own
 * segment, and the translucent accent would show twice behind it.
 */
export function treeGuideStyle(
	depth: number,
	activeGuideLevel: number | null,
	gapUnits?: number
): CSSProperties {
	if (gapUnits === 0) return {};
	const length = gapUnits === undefined ? "100%" : `calc(var(--spacing) * ${gapUnits})`;
	const levels = Array.from({ length: depth }, (_, level) => level);
	const guides = levels.map((level) => ({ color: GUIDE_COLOR, level }));
	if (activeGuideLevel !== null && activeGuideLevel < depth) {
		// First is topmost, so the accent covers the divider line beneath it.
		guides.unshift({ color: ACTIVE_GUIDE_COLOR, level: activeGuideLevel });
	}
	if (guides.length === 0) return {};
	return {
		backgroundImage: guides.map((guide) => layer(guide.color)).join(", "),
		backgroundSize: guides.map(() => `1px ${length}`).join(", "),
		backgroundPosition: guides.map((guide) => `${guideX(guide.level)} 0`).join(", "),
		backgroundRepeat: "no-repeat",
	};
}
