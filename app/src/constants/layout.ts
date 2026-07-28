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
 * Horizontal step per tree depth level (px). Applied as padding *inside* a row
 * so the row still spans the full panel width - see CollectionItem.
 */
export const INDENT_STEP = 12;

/* ── Document tab strip (TitleBar) ───────────────────────────────────────── */

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
