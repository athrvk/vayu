/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main pane's heading outline (#3498).
 *
 * A heading's level is a fact about where it is drawn, not about what it is.
 * The run report's summary cards sit under the run's title in History and under
 * the report's own crumb on the dashboard; an empty state can be a whole tab or
 * one card's body. So the primitives that draw a title (`CardTitle`,
 * `EmptyState`, `ErrorState`, a `TabBreadcrumb` that titles its pane, and the
 * headings of a component more than one surface renders) draw a `Heading`,
 * which asks this context for its element, and a surface states its structure
 * in one place: the Shell opens the outline at 1 around the active tab, and
 * whatever draws a tab's `h1` wraps the rest of the tab in a `HeadingSection`
 * (both in `heading.tsx`). A card does not open a section: its title is the
 * heading, and a title-less card's empty state stands in for it at the same
 * level.
 *
 * Outside the outline - the drawer, the context bar, the title bar - the level
 * is `null`. Those bands draw their own fixed headings, and an empty state
 * there stays a paragraph rather than guessing where it sits. A dialog opens
 * its own at 3, under its `h2` title: context crosses the portal, so without
 * that a dialog opened from a tab would inherit the tab's level.
 */

import { createContext, useContext } from "react";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type HeadingTag = `h${HeadingLevel}`;

export const HeadingLevelContext = createContext<HeadingLevel | null>(null);

/** The level a heading drawn here takes, or `null` outside the main pane's outline. */
export function useHeadingLevel(): HeadingLevel | null {
	return useContext(HeadingLevelContext);
}
