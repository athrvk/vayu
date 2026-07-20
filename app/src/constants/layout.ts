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
 * Default drawer width (px) — one value for every view.
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
 * so the row still spans the full panel width — see CollectionItem.
 */
export const INDENT_STEP = 12;
