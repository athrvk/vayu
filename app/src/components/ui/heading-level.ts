/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main pane's heading outline (#3498). A heading's level is where it is drawn, not what it is:
 * the run report's summary cards sit under the run's title in History and under the report's crumb
 * on the dashboard, and an empty state can be a tab or one card's body. So the title primitives
 * (`CardTitle`, `EmptyState`, `ErrorState`, a `TabBreadcrumb` titling its pane, a shared
 * component's headings) draw a `Heading`, which asks this context for its element, and a surface
 * states its structure once: the Shell opens the outline at 1 around the active tab, and whatever
 * draws a tab's `h1` wraps the rest in a `HeadingSection` (both in `heading.tsx`). A card opens no
 * section: its title is the heading, and a title-less card's empty state stands in at that level.
 * Outside the outline (the drawer, the context bar, the title bar) the level is `null`: those bands
 * draw fixed headings, and an empty state there stays a paragraph. A dialog opens its own at 3,
 * under its `h2` title, since context crosses the portal.
 */

import { createContext, useContext } from "react";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type HeadingTag = `h${HeadingLevel}`;

export const HeadingLevelContext = createContext<HeadingLevel | null>(null);

/** The level a heading drawn here takes, or `null` outside the main pane's outline. */
export function useHeadingLevel(): HeadingLevel | null {
	return useContext(HeadingLevelContext);
}
