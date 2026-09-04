/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Min/max width for resizable side panels (drawer, context bar). */
export const PANEL_MIN_WIDTH = 220;
export const PANEL_MAX_WIDTH = 480;

/**
 * Default drawer width (px) - one value for every view.
 *
 * Width used to be stored per view, with history at 320 and the rest at 260.
 * Switching to History therefore widened the drawer and pushed the main content
 * 60px right, shrinking it by the same amount, then moved it back on the way
 * out. Editors share one sidebar width across views for exactly this reason: the
 * content area must not resize because you glanced at a different list.
 */
export const DEFAULT_DRAWER_WIDTH = 260;

/** Default width of the right context bar (px). */
export const DEFAULT_CONTEXT_BAR_WIDTH = 252;

/**
 * Context-bar sections that start collapsed, against the store's standing rule
 * that a section ships expanded (`contextBarCollapsedSections`, collapsed by
 * exception).
 *
 * That rule exists so a section added in a later release is never invisible to
 * an existing user, and `code` is the one entry allowed to break it, for the
 * reason the rule is about in the first place: an expanded Code section issues a
 * `POST /compose` on mount, so with the bar open the app composed a snippet on
 * every request tab the user opened, whether or not they ever looked at it. A
 * section nobody asked for that costs a server round trip is worse off expanded
 * than a section nobody can see is off collapsed.
 *
 * It is a default, not a policy: the ids here seed a fresh install and are
 * applied once at the v3 -> v4 migration, and a user's own toggle overrides one
 * from then on.
 */
export const CONTEXT_BAR_DEFAULT_COLLAPSED: readonly string[] = ["code"];

/**
 * Section ids that no longer exist, pruned from a persisted collapse list on
 * migration.
 *
 * An orphaned id is harmless on its own - nothing looks it up once the section
 * is gone - but it is a persisted name for something that does not exist, and
 * the list is small enough that keeping it truthful is free. `environment` was
 * retired in #1310: the title bar's environment selector shows and switches the
 * active environment one click away on the same screen, so the section repeated
 * a control visible at the same moment.
 */
export const RETIRED_CONTEXT_BAR_SECTIONS: readonly string[] = ["environment"];

/**
 * Horizontal step per tree depth level (px). Applied as padding *inside* a row
 * so the row still spans the full panel width - see CollectionItem.
 */
export const INDENT_STEP = 12;

/** Left edge of a tree row at `depth` (px), the root row's padding included. */
export function rowInsetPx(depth: number): number {
	return 8 + depth * INDENT_STEP;
}

/**
 * Left edge for anything rendered *inside* a row's `role="group"` at `depth` -
 * a placeholder, an inline form, a skeleton, an inline error.
 *
 * It is the inset a child row of that group takes, not a padding of its own:
 * the group's contents belong to one level, so they line up whether the level
 * currently holds rows, one message, or a half-typed name. Derived from
 * `rowInsetPx` rather than restated, because the two drifting apart is the
 * defect (#1372) - a nested folder's "Empty folder" sat at the tree's left
 * edge, left of its own parent's label.
 */
export function childInsetPx(depth: number): number {
	return rowInsetPx(depth + 1);
}

/* ── Document tab strip (over the content column) ────────────────────────── */

/**
 * A document tab sizes to its own name, between these bounds, and the strip
 * overflows rather than compressing everything to fit.
 *
 * The old strip did the opposite: `min-w-20 max-w-50 shrink` let every tab
 * shrink proportionally, so opening a ninth made the other eight worse. With
 * eight open at ~1450px each got about 140px, of which 71px was chrome - method
 * text, a close button reserved on every tab whether hovered or not, and 24px of
 * padding - leaving 93px for a name that needed 104px. Every tab was cut, and
 * cut mid-glyph, because the label had no ellipsis either.
 *
 * The floor is a click target, not a label: below it a tab cannot say anything
 * useful, so the strip sends tabs to the overflow menu instead of shrinking
 * past it. The ceiling stops one long name from crowding out its neighbours.
 */
export const TAB_MIN_WIDTH = 90;
export const TAB_MAX_WIDTH = 220;

/**
 * Width reserved for the overflow control when tabs do not all fit.
 *
 * Deliberately reserved *before* deciding how many tabs to show: fitting one
 * more tab and then discovering there is nowhere to put the "+3" is how a strip
 * ends up hiding tabs with no way to reach them.
 */
export const TAB_OVERFLOW_WIDTH = 56;

/** Width of the trailing "new tab" button, also reserved up front. */
export const TAB_NEW_BUTTON_WIDTH = 30;

/* ── GraphQL body: the Variables pane ────────────────────────────────────── */

/**
 * How much of the editor stack the Variables pane takes when it is open, and
 * the bounds a remembered size is clamped to.
 *
 * A percentage rather than pixels because the pane splits a stack whose own
 * height is whatever the response viewer left it. The default is the size the
 * pane shipped with; the floor is the panel's `minSize`, below which the panel
 * collapses instead of shrinking.
 */
export const DEFAULT_GRAPHQL_VARIABLES_SIZE = 35;
export const GRAPHQL_VARIABLES_MIN_SIZE = 15;
export const GRAPHQL_VARIABLES_MAX_SIZE = 75;

/**
 * Height of a GraphQL editor pane's header row (px).
 *
 * The Variables pane collapses to exactly its header, so this is both the
 * header's own height and the panel's `collapsedSize` - one constant, because
 * the two disagreeing is a collapsed pane that clips its own badges or leaves a
 * strip of dead editor under them.
 */
export const GRAPHQL_PANE_HEADER_HEIGHT = 28;
