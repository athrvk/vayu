/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ComponentType } from "react";
import type { Tab } from "@/stores";

/** What every section is handed: the tab it is describing. */
export interface ContextBarSectionProps {
	tab: Tab;
}

/**
 * How much this section has to say about the tab in front of it, read from the
 * section's own data rather than from the tab's shape.
 *
 * `appliesTo` answers the structural question - does this section belong on a
 * tab of this kind - and it is all a tab can answer, because a tab carries a
 * type and an entity id and nothing else. Three of the seven request-tab
 * sections used to exist only to say they did not apply ("This request does not
 * send a GraphQL body", "No cookies held for this host", "This request has not
 * been sent yet"), which is a header the reader scans past on every tab.
 *
 * - `"content"` - draw it as usual, honouring the user's collapse state.
 * - `"hidden"` - draw nothing. For a section that structurally does not apply to
 *   *this* request: GraphQL on a non-GraphQL body, cookies before the URL has a
 *   host.
 * - `{ empty: note }` - draw the header alone, with `note` after the title and
 *   no chevron, because there is nothing to expand. The note travels with the
 *   verdict rather than sitting on the registry entry so that an empty state
 *   without a word for it cannot be expressed.
 */
export type SectionRelevance = "content" | "hidden" | { empty: string };

/**
 * A section's relevance, as a hook, so it can read the same queries the section
 * component reads and hit the same cache entries.
 *
 * Two rules a relevance hook has to keep:
 *
 * 1. **While the answer is not yet known, say `"content"`** and let the section
 *    render its own loading line. A header that dims and then expands a moment
 *    later flickers, and the queries behind these answers are usually already
 *    warm (the request builder on the same screen holds `useRequestQuery`).
 *    The one exception is a verdict that guards an expensive mount - see
 *    `useGraphQLRelevance` in `relevance.ts`, where the unknown case is
 *    `"hidden"` because revealing costs a 320KB chunk.
 * 2. **Do not reach for data the section itself would not read.** The hook runs
 *    whenever the bar is open, including for a collapsed section, so an answer
 *    that costs a query the section does not already make is a query the bar
 *    now makes on every tab.
 */
export type SectionRelevanceHook = (tab: Tab) => SectionRelevance;

/**
 * One entry in the bar's section registry.
 *
 * Sections are leaf components over the existing query layer - there is no
 * shared bar-wide state for them to coordinate through, deliberately. A section
 * that needs data asks for it with the same hook any other surface would use,
 * and mounts only while it is expanded, so a bar the user leaves open costs
 * nothing for the sections they keep collapsed.
 */
export interface ContextBarSection {
	/** Stable across releases - it is the key the collapsed state persists under. */
	id: string;
	title: string;
	/**
	 * Whether this section has anything to say about this tab. Takes the whole
	 * tab, not just its type, because Phase 2's collection and run sections turn
	 * on the entity as well.
	 */
	appliesTo: (tab: Tab) => boolean;
	/**
	 * Whether it has anything to say about *this* request, once its data is in.
	 *
	 * Optional: a section without one is `"content"` by definition, which is why
	 * the collection and run sections carry none. See `SectionRelevance`.
	 */
	useRelevance?: SectionRelevanceHook;
	Component: ComponentType<ContextBarSectionProps>;
}
